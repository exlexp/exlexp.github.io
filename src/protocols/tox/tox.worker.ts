/// <reference lib="webworker" />

import { base64ToBytes, bytesToBase64, utf8 } from '../../security/encoding';
import { directSocketFactories, ToxSocketBridge } from './socketBridge';
import { gatewaySocketFactories } from './webSocketSocket';
import type { ToxBootstrapNode, ToxCommand, ToxEvent, ToxFriend, ToxWorkerRequest, ToxWorkerResponse } from './types';

interface ToxCoreModule {
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
  _malloc(size: number): number;
  _free(pointer: number): void;
  _relay_tox_new(savedata: number, length: number): number;
  _relay_tox_kill(tox: number): void;
  _relay_tox_iterate(tox: number): void;
  _relay_tox_interval(tox: number): number;
  _relay_tox_address(tox: number, output: number): void;
  _relay_tox_savedata_size(tox: number): number;
  _relay_tox_savedata(tox: number, output: number): void;
  _relay_tox_set_name(tox: number, value: number, length: number): number;
  _relay_tox_set_status(tox: number, value: number, length: number): number;
  _relay_tox_add_friend(tox: number, address: number, message: number, length: number): number;
  _relay_tox_accept_friend(tox: number, publicKey: number): number;
  _relay_tox_remove_friend(tox: number, friendNumber: number): number;
  _relay_tox_send_message(tox: number, friendNumber: number, message: number, length: number): number;
  _relay_tox_bootstrap(tox: number, host: number, port: number, publicKey: number): number;
  _relay_tox_add_relay(tox: number, host: number, port: number, publicKey: number): number;
  _relay_tox_friend_count(tox: number): number;
  _relay_tox_friend_numbers(tox: number, output: number): void;
  _relay_tox_friend_public_key(tox: number, friendNumber: number, output: number): number;
}

interface ToxCoreFactoryOptions {
  locateFile(path: string): string;
  relayHasDirectSockets(): boolean;
  relayNetSocket(domain: number, type: number, protocol: number): number;
  relayNetBind(handle: number, family: number, port: number): number;
  relayNetConnect(handle: number, host: string, port: number): number;
  relayNetSend(handle: number, data: Uint8Array): number;
  relayNetSendTo(handle: number, data: Uint8Array, host: string, port: number): number;
  relayNetReceive(handle: number, maximum: number): Uint8Array | undefined;
  relayNetReceiveFrom(handle: number, maximum: number): { data: Uint8Array; address: Uint8Array; family: number; port: number } | undefined;
  relayNetReceiveBufferSize(handle: number): number;
  relayNetClose(handle: number): number;
  relayEmit(event: CoreEvent): void;
}

type CoreEvent =
  | { type: 'connection'; status: number }
  | { type: 'friend-connection'; friendNumber: number; status: number }
  | { type: 'friend-request'; publicKey: string; message: string }
  | { type: 'message'; friendNumber: number; messageType: number; text: string }
  | { type: 'receipt'; friendNumber: number; messageId: number };

let module: ToxCoreModule | undefined;
let tox = 0;
let iterationTimer: number | undefined;
let saveTimer: number | undefined;
let bootstrapTimer: number | undefined;
let slowConnectionTimer: number | undefined;
let activeNodes: ToxBootstrapNode[] = [];
let bootstrapOffset = 0;
let selfOnline = false;
let bridge: ToxSocketBridge | undefined;

self.addEventListener('message', (message: MessageEvent<ToxWorkerRequest>) => {
  void handle(message.data.command)
    .then((result) => post({ kind: 'reply', requestId: message.data.requestId, ok: true, result }))
    .catch((error: unknown) => post({
      kind: 'reply', requestId: message.data.requestId, ok: false,
      error: error instanceof Error ? error.message : 'Tox operation failed',
    }));
});

async function handle(command: ToxCommand): Promise<unknown> {
  switch (command.type) {
    case 'start': return start(command.savedata, command.name, command.status, command.nodes, command.gatewayUrls);
    case 'stop': return stop();
    case 'snapshot': return snapshot();
    case 'set-profile':
      requireRunning();
      setUtf8(command.name, (pointer, length) => module!._relay_tox_set_name(tox, pointer, length));
      setUtf8(command.status, (pointer, length) => module!._relay_tox_set_status(tox, pointer, length));
      emitSavedata();
      return undefined;
    case 'add-friend': return addFriend(command.address, command.message);
    case 'accept-friend': return acceptFriend(command.publicKey);
    case 'remove-friend':
      requireRunning();
      assertCoreResult(module!._relay_tox_remove_friend(tox, command.friendNumber), 'Remove friend');
      emitSavedata();
      return undefined;
    case 'send-message': return sendMessage(command.friendNumber, command.text);
  }
}

async function start(savedata: string | undefined, name: string, status: string, nodes: ToxBootstrapNode[], gatewayUrls: string[]): Promise<void> {
  if (tox) await stop();
  postEvent({ type: 'state', state: 'starting' });
  const directSockets = typeof TCPSocket === 'function' && typeof UDPSocket === 'function';
  if (!directSockets && gatewayUrls.length === 0) throw new Error('Tox gateway is not configured');
  bridge = new ToxSocketBridge(
    directSockets ? directSocketFactories : gatewaySocketFactories(gatewayUrls),
    ({ transport, state, host, port }) => postEvent({ type: 'transport', transport, state, host, port }),
  );
  module = await loadCore(directSockets);
  const savedataBytes = savedata ? base64ToBytes(savedata) : undefined;
  tox = savedataBytes?.byteLength
    ? withBytes(savedataBytes, (pointer, length) => module!._relay_tox_new(pointer, length))
    : module._relay_tox_new(0, 0);
  savedataBytes?.fill(0);
  if (!tox) throw new Error('c-toxcore could not create the local profile');
  setUtf8(name, (pointer, length) => module!._relay_tox_set_name(tox, pointer, length));
  setUtf8(status, (pointer, length) => module!._relay_tox_set_status(tox, pointer, length));
  postEvent({ type: 'state', state: 'connecting' });
  activeNodes = nodes.filter((item) => item.enabled && isNumericIp(item.host));
  bootstrapNextRelays(activeNodes.length);
  scheduleIteration();
  saveTimer = self.setInterval(emitSavedata, 30_000) as unknown as number;
  bootstrapTimer = self.setInterval(() => {
    bootstrapNextRelays(selfOnline ? 1 : 3);
  }, 12_000) as unknown as number;
  slowConnectionTimer = self.setTimeout(() => {
    if (!selfOnline) postEvent({ type: 'state', state: 'reconnecting' });
  }, 12_000) as unknown as number;
  const current = snapshot();
  postEvent({ type: 'ready', ...current });
}

async function stop(): Promise<void> {
  if (iterationTimer !== undefined) self.clearTimeout(iterationTimer);
  if (saveTimer !== undefined) self.clearInterval(saveTimer);
  if (bootstrapTimer !== undefined) self.clearInterval(bootstrapTimer);
  if (slowConnectionTimer !== undefined) self.clearTimeout(slowConnectionTimer);
  iterationTimer = undefined;
  saveTimer = undefined;
  bootstrapTimer = undefined;
  slowConnectionTimer = undefined;
  activeNodes = [];
  bootstrapOffset = 0;
  selfOnline = false;
  if (tox && module) {
    emitSavedata();
    module._relay_tox_kill(tox);
  }
  tox = 0;
  await bridge?.shutdown();
  bridge = undefined;
  postEvent({ type: 'state', state: 'offline' });
}

function snapshot(): { address: string; savedata: string; friends: ToxFriend[] } {
  requireRunning();
  return { address: selfAddress(), savedata: savedata(), friends: friends() };
}

function bootstrap(node: ToxBootstrapNode): void {
  const publicKey = hexBytes(node.publicKey, 32, 'bootstrap public key');
  withCString(node.host, (hostPointer) => withBytes(publicKey, (keyPointer) => {
    module!._relay_tox_bootstrap(tox, hostPointer, node.port, keyPointer);
    for (const port of node.tcpPorts) module!._relay_tox_add_relay(tox, hostPointer, port, keyPointer);
    return 0;
  }));
}

function bootstrapNextRelays(requestedCount = 3): void {
  if (!activeNodes.length) return;
  const count = Math.min(Math.max(1, requestedCount), activeNodes.length);
  for (let index = 0; index < count; index += 1) {
    const node = activeNodes[(bootstrapOffset + index) % activeNodes.length];
    if (node) bootstrap(node);
  }
  bootstrapOffset = (bootstrapOffset + count) % activeNodes.length;
}

function addFriend(address: string, message: string): number {
  requireRunning();
  const addressBytes = hexBytes(address, 38, 'Tox ID');
  const messageBytes = utf8(message.trim() || 'Hello');
  if (messageBytes.byteLength > 1016) throw new Error('Friend request is too long');
  const result = withBytes(addressBytes, (addressPointer) => withBytes(messageBytes, (messagePointer, length) =>
    module!._relay_tox_add_friend(tox, addressPointer, messagePointer, length)));
  assertCoreResult(result, 'Add friend');
  emitSavedata();
  bootstrapNextRelays(activeNodes.length);
  return result;
}

function acceptFriend(publicKey: string): number {
  requireRunning();
  const result = withBytes(hexBytes(publicKey, 32, 'public key'), (pointer) => module!._relay_tox_accept_friend(tox, pointer));
  assertCoreResult(result, 'Accept friend');
  emitSavedata();
  bootstrapNextRelays(activeNodes.length);
  return result;
}

function sendMessage(friendNumber: number, text: string): number {
  requireRunning();
  const value = utf8(text);
  if (!value.byteLength || value.byteLength > 1372) throw new Error('Tox messages must be between 1 and 1372 bytes');
  const result = withBytes(value, (pointer, length) => module!._relay_tox_send_message(tox, friendNumber, pointer, length));
  assertCoreResult(result, 'Send message');
  return result;
}

async function loadCore(directSockets: boolean): Promise<ToxCoreModule> {
  const publicBase = import.meta.env.BASE_URL;
  const response = await fetch(`${publicBase}tox/toxcore.mjs`, { cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) throw new Error('c-toxcore JavaScript module is unavailable');
  const objectUrl = URL.createObjectURL(new Blob([await response.text()], { type: 'text/javascript' }));
  try {
    const imported = await import(/* @vite-ignore */ objectUrl) as { default: (options: ToxCoreFactoryOptions) => Promise<ToxCoreModule> };
    return await imported.default({
    locateFile: (path) => `${publicBase}tox/${path}`,
    relayHasDirectSockets: () => directSockets,
    relayNetSocket: (domain, type, protocol) => bridge!.socket(domain, type, protocol),
    relayNetBind: (handle, family, port) => bridge!.bind(handle, family, port),
    relayNetConnect: (handle, host, port) => bridge!.connect(handle, host, port),
    relayNetSend: (handle, data) => bridge!.send(handle, data),
    relayNetSendTo: (handle, data, host, port) => bridge!.sendTo(handle, data, host, port),
    relayNetReceive: (handle, maximum) => bridge!.receive(handle, maximum),
    relayNetReceiveFrom: (handle, maximum) => {
      const packet = bridge!.receiveFrom(handle, maximum);
      if (!packet) return undefined;
      const address = parseNumericIp(packet.remoteAddress);
      return address ? { data: packet.data, address: address.bytes, family: address.family, port: packet.remotePort } : undefined;
    },
    relayNetReceiveBufferSize: (handle) => bridge!.receiveBufferSize(handle),
    relayNetClose: (handle) => bridge!.close(handle),
      relayEmit: handleCoreEvent,
    });
  } finally { URL.revokeObjectURL(objectUrl); }
}

function handleCoreEvent(event: CoreEvent): void {
  switch (event.type) {
    case 'connection':
      selfOnline = event.status > 0;
      if (selfOnline && slowConnectionTimer !== undefined) {
        self.clearTimeout(slowConnectionTimer);
        slowConnectionTimer = undefined;
      }
      postEvent({ type: 'state', state: selfOnline ? 'online' : 'reconnecting' });
      break;
    case 'friend-connection':
      postEvent({ type: 'friend-connection', friendNumber: event.friendNumber, publicKey: friendPublicKey(event.friendNumber), online: event.status > 0 });
      break;
    case 'friend-request':
      postEvent(event);
      break;
    case 'message':
      postEvent({ type: 'message', friendNumber: event.friendNumber, publicKey: friendPublicKey(event.friendNumber), text: event.text, timestamp: Date.now() });
      break;
    case 'receipt':
      postEvent({ ...event, publicKey: friendPublicKey(event.friendNumber) });
      break;
  }
}

function scheduleIteration(): void {
  if (!tox || !module) return;
  module._relay_tox_iterate(tox);
  const delay = Math.max(5, Math.min(1000, module._relay_tox_interval(tox)));
  iterationTimer = self.setTimeout(scheduleIteration, delay) as unknown as number;
}

function selfAddress(): string {
  return readBytes(38, (pointer) => module!._relay_tox_address(tox, pointer));
}

function savedata(): string {
  const size = module!._relay_tox_savedata_size(tox);
  if (size <= 0 || size > 16 * 1024 * 1024) throw new Error('Invalid Tox savedata size');
  const pointer = module!._malloc(size);
  try {
    module!._relay_tox_savedata(tox, pointer);
    return bytesToBase64(module!.HEAPU8.slice(pointer, pointer + size));
  } finally { module!._free(pointer); }
}

function friends(): ToxFriend[] {
  const count = module!._relay_tox_friend_count(tox);
  if (!count) return [];
  const pointer = module!._malloc(count * 4);
  try {
    module!._relay_tox_friend_numbers(tox, pointer);
    return Array.from(module!.HEAP32.subarray(pointer / 4, pointer / 4 + count), (friendNumber) => ({
      friendNumber,
      publicKey: readBytes(32, (output) => assertCoreResult(module!._relay_tox_friend_public_key(tox, friendNumber, output), 'Read friend')),
    }));
  } finally { module!._free(pointer); }
}

function friendPublicKey(friendNumber: number): string {
  return readBytes(32, (output) => assertCoreResult(module!._relay_tox_friend_public_key(tox, friendNumber, output), 'Read friend'));
}

function emitSavedata(): void {
  if (tox) postEvent({ type: 'savedata', savedata: savedata() });
}

function setUtf8(value: string, callback: (pointer: number, length: number) => number): void {
  assertCoreResult(withBytes(utf8(value), callback), 'Update Tox profile');
}

function withBytes<T>(value: Uint8Array, callback: (pointer: number, length: number) => T): T {
  if (!module) throw new Error('c-toxcore is not loaded');
  const pointer = module._malloc(Math.max(1, value.byteLength));
  try {
    module.HEAPU8.set(value, pointer);
    return callback(pointer, value.byteLength);
  } finally { module._free(pointer); }
}

function withCString<T>(value: string, callback: (pointer: number) => T): T {
  const encoded = utf8(`${value}\0`);
  return withBytes(encoded, (pointer) => callback(pointer));
}

function readBytes(length: number, callback: (pointer: number) => void | number): string {
  if (!module) throw new Error('c-toxcore is not loaded');
  const pointer = module._malloc(length);
  try {
    callback(pointer);
    return [...module.HEAPU8.slice(pointer, pointer + length)].map((value) => value.toString(16).padStart(2, '0')).join('').toUpperCase();
  } finally { module._free(pointer); }
}

function hexBytes(value: string, expectedBytes: number, label: string): Uint8Array {
  const normalized = value.replace(/\s+/g, '').toUpperCase();
  if (!new RegExp(`^[0-9A-F]{${expectedBytes * 2}}$`).test(normalized)) throw new Error(`Invalid ${label}`);
  return Uint8Array.from({ length: expectedBytes }, (_, index) => Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16));
}

function assertCoreResult(result: number, operation: string): void {
  if (result < 0) throw new Error(`${operation} failed (toxcore ${result})`);
}

function requireRunning(): void {
  if (!module || !tox) throw new Error('Tox profile is offline');
}

function isNumericIp(value: string): boolean {
  return parseNumericIp(value) !== undefined;
}

function parseNumericIp(value: string): { family: 2 | 10; bytes: Uint8Array } | undefined {
  const ipv4 = value.split('.');
  if (ipv4.length === 4 && ipv4.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    return { family: 2, bytes: Uint8Array.from(ipv4.map(Number)) };
  }
  if (!value.includes(':')) return undefined;
  const halves = value.toLowerCase().split('::');
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) return undefined;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 2 && missing < 1)) return undefined;
  const words = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return undefined;
  const bytes = new Uint8Array(16);
  words.forEach((word, index) => {
    const number = Number.parseInt(word, 16);
    bytes[index * 2] = number >> 8;
    bytes[index * 2 + 1] = number & 0xff;
  });
  return { family: 10, bytes };
}

function postEvent(event: ToxEvent): void { post({ kind: 'event', event }); }
function post(response: ToxWorkerResponse): void { self.postMessage(response); }
