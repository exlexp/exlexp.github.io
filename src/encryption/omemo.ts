import {
  InMemoryStore,
  KeyHelper,
  OMEMOAddress,
  SessionBuilder,
  SessionCipher,
  curvePubKeyToEd25519PubKey,
  type KeyPair,
  type PreKeyBundle,
} from 'libomemo.js';
import type { OmemoAccountState, OmemoStoredValue } from '../models/types';
import type { XmppClient, XmppOmemoPayload } from '../protocols/xmpp/client';
import { escapeXml, firstDescendant, parseXmppElement } from '../protocols/xmpp/xml';
import { base64ToBytes, bytesToBase64, decodeUtf8, randomBytes, toArrayBuffer, utf8 } from '../security/encoding';

const OMEMO_NS = 'urn:xmpp:omemo:2' as const;
const DEVICES_NODE = `${OMEMO_NS}:devices`;
const BUNDLES_NODE = `${OMEMO_NS}:bundles`;
const PUBSUB_NS = 'http://jabber.org/protocol/pubsub';
const PREKEY_TARGET = 100;
const MAX_REMOTE_DEVICES = 100;
const MAX_OMEMO_PAYLOAD_BYTES = 256 * 1024;
const CACHE_TTL_MS = 5 * 60_000;

export interface OmemoEncryptedMessage {
  xml: string;
  devices: Array<{ jid: string; deviceId: number; fingerprint: string }>;
}

interface DeviceCacheEntry { expiresAt: number; ids: number[] }

export class OmemoEngine {
  private readonly store = new InMemoryStore();
  private readonly deviceCache = new Map<string, DeviceCacheEntry>();

  private constructor(
    private readonly client: XmppClient,
    readonly ownJid: string,
    private state: OmemoAccountState,
    private readonly persist: (state: OmemoAccountState) => Promise<void>,
  ) {
    this.store.store = decodeStore(state.store);
    this.client.setOmemoDeviceId(state.deviceId);
  }

  static async open(
    client: XmppClient,
    jid: string,
    saved: OmemoAccountState | undefined,
    persist: (state: OmemoAccountState) => Promise<void>,
  ): Promise<OmemoEngine> {
    const ownJid = bareJid(jid);
    if (!ownJid.includes('@')) throw new Error('OMEMO requires a complete XMPP JID');
    const state = saved ? validateState(saved) : await createState();
    const engine = new OmemoEngine(client, ownJid, state, persist);
    if (!saved) await engine.save();
    return engine;
  }

  get deviceId(): number { return this.state.deviceId; }

  async announce(): Promise<void> {
    await this.replenishPreKeys();
    let devices: number[] = [];
    try { devices = await this.fetchDevices(this.ownJid, true); } catch { /* a new PEP node has no item yet */ }
    if (!devices.includes(this.deviceId)) devices.push(this.deviceId);
    const deviceXml = [...new Set(devices)].slice(0, MAX_REMOTE_DEVICES).map((id) => `<device id="${id}"/>`).join('');
    await this.client.requestIq(
      `<pubsub xmlns="${PUBSUB_NS}"><publish node="${DEVICES_NODE}"><item id="current"><devices xmlns="${OMEMO_NS}">${deviceXml}</devices></item></publish>` +
      publishOptions([['pubsub#access_model', 'open']]) + `</pubsub>`,
      { type: 'set' },
    );
    await this.publishBundle();
    this.deviceCache.set(this.ownJid, { expiresAt: Date.now() + CACHE_TTL_MS, ids: devices });
  }

  async revoke(): Promise<void> {
    const devices = (await this.fetchDevices(this.ownJid, true)).filter((id) => id !== this.deviceId);
    const deviceXml = devices.map((id) => `<device id="${id}"/>`).join('');
    await this.client.requestIq(
      `<pubsub xmlns="${PUBSUB_NS}"><publish node="${DEVICES_NODE}"><item id="current"><devices xmlns="${OMEMO_NS}">${deviceXml}</devices></item></publish></pubsub>`,
      { type: 'set' },
    );
    await this.client.requestIq(
      `<pubsub xmlns="${PUBSUB_NS}"><retract node="${BUNDLES_NODE}" notify="true"><item id="${this.deviceId}"/></retract></pubsub>`,
      { type: 'set' },
    );
    this.client.setOmemoDeviceId(undefined);
  }

  async encrypt(recipientJid: string, plaintext: string): Promise<OmemoEncryptedMessage> {
    const recipient = bareJid(recipientJid);
    if (!recipient.includes('@')) throw new Error('OMEMO recipient JID is invalid');
    const targets = new Map<string, number[]>();
    const remote = await this.fetchDevices(recipient);
    if (remote.length === 0) throw new Error('The contact has no OMEMO devices; encrypted sending was refused');
    targets.set(recipient, remote);
    const ownDevices = (await this.fetchDevices(this.ownJid).catch(() => [])).filter((id) => id !== this.deviceId);
    if (ownDevices.length) targets.set(this.ownJid, ownDevices);

    const envelope = createSceEnvelope(this.ownJid, plaintext);
    const contentKey = randomBytes(32);
    try {
      const encryptedPayload = await encryptPayload(contentKey, utf8(envelope));
      const keyMaterial = new Uint8Array(48);
      keyMaterial.set(contentKey);
      keyMaterial.set(encryptedPayload.mac, 32);
      const keyGroups: string[] = [];
      const devices: OmemoEncryptedMessage['devices'] = [];

      for (const [jid, ids] of targets) {
        const keys: string[] = [];
        for (const deviceId of ids.slice(0, MAX_REMOTE_DEVICES)) {
          const address = new OMEMOAddress(jid, deviceId);
          const cipher = new SessionCipher(this.store, address, OMEMO_NS);
          if (!(await cipher.hasOpenSession())) {
            const bundle = await this.fetchBundle(jid, deviceId);
            await new SessionBuilder(this.store, address, OMEMO_NS).processPreKey(bundle);
          }
          const encryptedKey = await cipher.encrypt(keyMaterial);
          const identity = await this.store.loadIdentityKey(address.toString());
          const wireKey = bytesToBase64(Uint8Array.from(encryptedKey.body, (character) => character.charCodeAt(0) & 0xff));
          keys.push(`<key rid="${deviceId}"${encryptedKey.kex ? ' kex="true"' : ''}>${wireKey}</key>`);
          devices.push({ jid, deviceId, fingerprint: identity ? fingerprint(identity) : '' });
        }
        keyGroups.push(`<keys jid="${escapeXml(jid)}">${keys.join('')}</keys>`);
      }
      await this.save();
      return {
        xml: `<encrypted xmlns="${OMEMO_NS}"><header sid="${this.deviceId}">${keyGroups.join('')}</header><payload>${bytesToBase64(encryptedPayload.ciphertext)}</payload></encrypted>`,
        devices,
      };
    } finally {
      contentKey.fill(0);
    }
  }

  async decrypt(senderJid: string, payload: XmppOmemoPayload): Promise<{ body: string; fingerprint: string }> {
    if (payload.namespace !== OMEMO_NS) throw new Error('Unsupported OMEMO version');
    const sender = bareJid(senderJid);
    const address = new OMEMOAddress(sender, payload.senderDeviceId);
    const cipher = new SessionCipher(this.store, address, OMEMO_NS);
    const keyResult = payload.keyExchange
      ? await cipher.decryptPreKeyWhisperMessage(payload.encryptedKey, 'base64')
      : await cipher.decryptWhisperMessage(payload.encryptedKey, 'base64');
    const keyMaterial = new Uint8Array(keyResult.plaintext);
    try {
      if (keyMaterial.byteLength !== 48) throw new Error('Invalid OMEMO content key');
      const plaintext = await decryptPayload(keyMaterial.subarray(0, 32), keyMaterial.subarray(32), base64ToBytes(payload.ciphertext));
      const envelope = parseXmppElement(decodeUtf8(toArrayBuffer(plaintext)));
      if (envelope.localName !== 'envelope' || envelope.namespaceURI !== 'urn:xmpp:sce:1') throw new Error('Invalid OMEMO SCE envelope');
      const claimedFrom = Array.from(envelope.children).find((child) => child.localName === 'from')?.getAttribute('jid');
      if (claimedFrom && bareJid(claimedFrom) !== sender) throw new Error('OMEMO sender binding failed');
      const content = Array.from(envelope.children).find((child) => child.localName === 'content');
      const body = content ? firstDescendant(content, 'body') : undefined;
      if (!body || body.namespaceURI !== 'jabber:client') throw new Error('OMEMO message has no supported body');
      const identity = await this.store.loadIdentityKey(address.toString());
      await this.replenishPreKeys();
      if (payload.keyExchange) await this.publishBundle();
      await this.save();
      return { body: body.textContent ?? '', fingerprint: identity ? fingerprint(identity) : '' };
    } finally {
      keyMaterial.fill(0);
    }
  }

  exportState(): OmemoAccountState {
    return { ...this.state, store: encodeStore(this.store.store) };
  }

  private async fetchDevices(jid: string, bypassCache = false): Promise<number[]> {
    const bare = bareJid(jid);
    const cached = this.deviceCache.get(bare);
    if (!bypassCache && cached && cached.expiresAt > Date.now()) return [...cached.ids];
    const iq = await this.client.requestIq(
      `<pubsub xmlns="${PUBSUB_NS}"><items node="${DEVICES_NODE}"><item id="current"/></items></pubsub>`,
      { to: bare },
    );
    const devices = Array.from(iq.getElementsByTagNameNS(OMEMO_NS, 'device'))
      .map((element) => Number(element.getAttribute('id')))
      .filter(validDeviceId);
    const ids = [...new Set(devices)].slice(0, MAX_REMOTE_DEVICES);
    this.deviceCache.set(bare, { expiresAt: Date.now() + CACHE_TTL_MS, ids });
    return ids;
  }

  private async fetchBundle(jid: string, deviceId: number): Promise<PreKeyBundle> {
    const iq = await this.client.requestIq(
      `<pubsub xmlns="${PUBSUB_NS}"><items node="${BUNDLES_NODE}"><item id="${deviceId}"/></items></pubsub>`,
      { to: bareJid(jid) },
    );
    const bundle = iq.getElementsByTagNameNS(OMEMO_NS, 'bundle')[0];
    if (!bundle) throw new Error(`OMEMO bundle is unavailable for device ${deviceId}`);
    const ik = requiredChildBytes(bundle, 'ik', 32, 32);
    const spk = requiredChild(bundle, 'spk');
    const spks = requiredChildBytes(bundle, 'spks', 64, 64);
    const prekeys = Array.from(bundle.getElementsByTagNameNS(OMEMO_NS, 'pk'));
    if (prekeys.length === 0 || prekeys.length > 200) throw new Error('OMEMO bundle has an unsafe PreKey count');
    const chosen = prekeys[crypto.getRandomValues(new Uint32Array(1))[0]! % prekeys.length]!;
    return {
      registrationId: deviceId,
      identityKey: toArrayBuffer(ik),
      signedPreKey: {
        keyId: positiveId(spk.getAttribute('id')),
        publicKey: toArrayBuffer(sizedElementBytes(spk, 32, 32)),
        signature: toArrayBuffer(spks),
      },
      preKey: {
        keyId: positiveId(chosen.getAttribute('id')),
        publicKey: toArrayBuffer(sizedElementBytes(chosen, 32, 32)),
      },
    };
  }

  private async publishBundle(): Promise<void> {
    const identity = await this.store.getIdentityKeyPair();
    const signed = await this.store.loadSignedPreKey(this.state.signedPreKeyId);
    if (!identity || !signed) throw new Error('Local OMEMO keys are incomplete');
    const identityEd = await curvePubKeyToEd25519PubKey(identity.pubKey);
    const prekeys = Object.entries(this.store.store)
      .filter(([key]) => key.startsWith('25519KeypreKey'))
      .slice(0, PREKEY_TARGET)
      .map(([key, value]) => {
        const id = positiveId(key.slice('25519KeypreKey'.length));
        const pair = value as KeyPair;
        return `<pk id="${id}">${bytesToBase64(wireCurvePublicKey(pair.pubKey))}</pk>`;
      });
    if (prekeys.length < 25) throw new Error('Local OMEMO bundle has too few PreKeys');
    const bundle = `<bundle xmlns="${OMEMO_NS}"><spk id="${this.state.signedPreKeyId}">${bytesToBase64(wireCurvePublicKey(signed.keyPair.pubKey))}</spk>` +
      `<spks>${escapeXml(this.state.signedPreKeySignature)}</spks><ik>${bytesToBase64(new Uint8Array(identityEd))}</ik><prekeys>${prekeys.join('')}</prekeys></bundle>`;
    await this.client.requestIq(
      `<pubsub xmlns="${PUBSUB_NS}"><publish node="${BUNDLES_NODE}"><item id="${this.deviceId}">${bundle}</item></publish>` +
      publishOptions([['pubsub#max_items', 'max'], ['pubsub#access_model', 'open']]) + `</pubsub>`,
      { type: 'set' },
    );
  }

  private async replenishPreKeys(): Promise<void> {
    const present = new Set(Object.keys(this.store.store)
      .filter((key) => key.startsWith('25519KeypreKey'))
      .map((key) => Number(key.slice('25519KeypreKey'.length))));
    while (present.size < PREKEY_TARGET) {
      const id = randomPositiveId();
      if (present.has(id)) continue;
      const key = await KeyHelper.generatePreKey(id);
      this.store.storePreKey(id, key.keyPair);
      present.add(id);
    }
  }

  private async save(): Promise<void> {
    this.state = this.exportState();
    await this.persist(structuredClone(this.state));
  }
}

async function createState(): Promise<OmemoAccountState> {
  const store = new InMemoryStore();
  const deviceId = randomPositiveId();
  const identity = await KeyHelper.generateIdentityKeyPair();
  const signedPreKeyId = randomPositiveId();
  const signed = await KeyHelper.generateSignedPreKey(identity, signedPreKeyId, OMEMO_NS);
  store.put('registrationId', deviceId);
  store.put('identityKey', identity);
  store.storeSignedPreKey(signedPreKeyId, signed.keyPair);
  const prekeyIds = new Set<number>();
  while (prekeyIds.size < PREKEY_TARGET) {
    const id = randomPositiveId();
    if (prekeyIds.has(id)) continue;
    const prekey = await KeyHelper.generatePreKey(id);
    store.storePreKey(prekey.keyId, prekey.keyPair);
    prekeyIds.add(id);
  }
  return {
    version: 1, deviceId, signedPreKeyId,
    signedPreKeySignature: bytesToBase64(new Uint8Array(signed.signature)),
    store: encodeStore(store.store),
  };
}

function validateState(state: OmemoAccountState): OmemoAccountState {
  if (state.version !== 1 || !validDeviceId(state.deviceId) || !validDeviceId(state.signedPreKeyId)) throw new Error('Invalid local OMEMO state');
  const signature = base64ToBytes(state.signedPreKeySignature);
  if (signature.byteLength !== 64) throw new Error('Invalid local OMEMO signature');
  if (!state.store || Object.keys(state.store).length > 10_000) throw new Error('Invalid local OMEMO store');
  decodeStore(state.store);
  return structuredClone(state);
}

function encodeStore(store: Record<string | number, unknown>): Record<string, OmemoStoredValue> {
  const encoded: Record<string, OmemoStoredValue> = {};
  for (const [key, value] of Object.entries(store)) {
    if (typeof value === 'number' && Number.isSafeInteger(value)) encoded[key] = { kind: 'number', value };
    else if (typeof value === 'string') encoded[key] = { kind: 'text', value };
    else if (value instanceof ArrayBuffer) encoded[key] = { kind: 'bytes', value: bytesToBase64(new Uint8Array(value)) };
    else if (isKeyPair(value)) encoded[key] = {
      kind: 'keypair', publicKey: bytesToBase64(new Uint8Array(value.pubKey)), privateKey: bytesToBase64(new Uint8Array(value.privKey)),
    };
    else throw new Error(`Unsupported OMEMO store value: ${key}`);
  }
  return encoded;
}

function decodeStore(store: Record<string, OmemoStoredValue>): Record<string, unknown> {
  const decoded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(store)) {
    if (key.length > 512) throw new Error('Invalid OMEMO store key');
    if (value.kind === 'number') decoded[key] = value.value;
    else if (value.kind === 'text') decoded[key] = value.value;
    else if (value.kind === 'bytes') decoded[key] = toArrayBuffer(base64ToBytes(value.value));
    else if (value.kind === 'keypair') decoded[key] = {
      pubKey: toArrayBuffer(base64ToBytes(value.publicKey)), privKey: toArrayBuffer(base64ToBytes(value.privateKey)),
    } satisfies KeyPair;
    else throw new Error('Invalid OMEMO store value');
  }
  return decoded;
}

async function encryptPayload(key: Uint8Array, plaintext: Uint8Array): Promise<{ ciphertext: Uint8Array; mac: Uint8Array }> {
  if (plaintext.byteLength > MAX_OMEMO_PAYLOAD_BYTES) throw new Error('OMEMO payload is too large');
  const material = await derivePayloadMaterial(key);
  const aesKey = await crypto.subtle.importKey('raw', toArrayBuffer(material.subarray(0, 32)), 'AES-CBC', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: toArrayBuffer(material.subarray(64, 80)) }, aesKey, toArrayBuffer(plaintext)));
  const hmacKey = await crypto.subtle.importKey('raw', toArrayBuffer(material.subarray(32, 64)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, toArrayBuffer(ciphertext))).slice(0, 16);
  material.fill(0);
  return { ciphertext, mac };
}

async function decryptPayload(key: Uint8Array, expectedMac: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
  if (ciphertext.byteLength < 16 || ciphertext.byteLength > MAX_OMEMO_PAYLOAD_BYTES) throw new Error('Invalid OMEMO payload size');
  const material = await derivePayloadMaterial(key);
  const hmacKey = await crypto.subtle.importKey('raw', toArrayBuffer(material.subarray(32, 64)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const actualMac = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, toArrayBuffer(ciphertext)));
  let difference = expectedMac.byteLength === 16 ? 0 : 1;
  for (let index = 0; index < 16; index += 1) difference |= (actualMac[index] ?? 0) ^ (expectedMac[index] ?? 0);
  if (difference !== 0) { material.fill(0); throw new Error('OMEMO payload authentication failed'); }
  const aesKey = await crypto.subtle.importKey('raw', toArrayBuffer(material.subarray(0, 32)), 'AES-CBC', false, ['decrypt']);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: toArrayBuffer(material.subarray(64, 80)) }, aesKey, toArrayBuffer(ciphertext)));
  } finally { material.fill(0); }
}

async function derivePayloadMaterial(key: Uint8Array): Promise<Uint8Array> {
  const hkdf = await crypto.subtle.importKey('raw', toArrayBuffer(key), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({
    name: 'HKDF', hash: 'SHA-256', salt: new ArrayBuffer(32), info: toArrayBuffer(utf8('OMEMO Payload')),
  }, hkdf, 640));
}

function createSceEnvelope(from: string, body: string): string {
  const paddingLength = 32 + (crypto.getRandomValues(new Uint8Array(1))[0]! % 96);
  const padding = bytesToBase64(randomBytes(paddingLength));
  return `<envelope xmlns="urn:xmpp:sce:1"><content><body xmlns="jabber:client">${escapeXml(body)}</body></content><rpad>${padding}</rpad><from jid="${escapeXml(from)}"/></envelope>`;
}

function publishOptions(fields: Array<[string, string]>): string {
  const values = fields.map(([name, value]) => `<field var="${name}"><value>${value}</value></field>`).join('');
  return `<publish-options><x xmlns="jabber:x:data" type="submit"><field var="FORM_TYPE" type="hidden"><value>http://jabber.org/protocol/pubsub#publish-options</value></field>${values}</x></publish-options>`;
}

function requiredChild(parent: Element, name: string): Element {
  const child = parent.getElementsByTagNameNS(OMEMO_NS, name)[0];
  if (!child) throw new Error(`OMEMO bundle is missing ${name}`);
  return child;
}

function requiredChildBytes(parent: Element, name: string, min: number, max: number): Uint8Array {
  return sizedElementBytes(requiredChild(parent, name), min, max);
}

function sizedElementBytes(element: Element, min: number, max: number): Uint8Array {
  const bytes = base64ToBytes(element.textContent?.trim() ?? '');
  if (bytes.byteLength < min || bytes.byteLength > max) throw new Error(`Invalid OMEMO ${element.localName} size`);
  return bytes;
}

function fingerprint(key: ArrayBuffer): string {
  return Array.from(new Uint8Array(key), (byte) => byte.toString(16).padStart(2, '0')).join('').match(/.{1,8}/g)?.join(' ') ?? '';
}

function isKeyPair(value: unknown): value is KeyPair {
  if (!value || typeof value !== 'object') return false;
  const pair = value as Partial<KeyPair>;
  return pair.pubKey instanceof ArrayBuffer && pair.privKey instanceof ArrayBuffer;
}

function wireCurvePublicKey(key: ArrayBuffer): Uint8Array {
  const bytes = new Uint8Array(key);
  if (bytes.byteLength !== 33 || bytes[0] !== 5) throw new Error('Invalid local OMEMO public key');
  return bytes.slice(1);
}

function randomPositiveId(): number {
  return (crypto.getRandomValues(new Uint32Array(1))[0]! & 0x7fffffff) || 1;
}

function positiveId(value: string | null): number {
  const id = Number(value);
  if (!validDeviceId(id)) throw new Error('Invalid OMEMO key identifier');
  return id;
}

function validDeviceId(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 0x7fffffff;
}

function bareJid(jid: string): string { return jid.split('/')[0] ?? jid; }
