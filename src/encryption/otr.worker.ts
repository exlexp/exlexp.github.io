/// <reference lib="webworker" />
import { DSA, OTR } from 'otr';

type Command =
  | { type: 'init'; privateKey?: string; instanceTag?: string }
  | { type: 'start'; peer: string }
  | { type: 'send'; peer: string; body: string; localId: string }
  | { type: 'receive'; peer: string; body: string; messageId: string; timestamp: number }
  | { type: 'end'; peer: string }
  | { type: 'reset' };

interface MessageMeta { messageId?: string; timestamp?: number; localId?: string }

const scope = self as DedicatedWorkerGlobalScope;
const sessions = new Map<string, OTR>();
let key: DSA | undefined;
let instanceTag = '';

function encodeBinary(value: string): string {
  let binary = '';
  for (let index = 0; index < value.length; index += 1) binary += String.fromCharCode(value.charCodeAt(index) & 0xff);
  return btoa(binary);
}

function decodeBinary(value: string): string {
  return atob(value);
}

function session(peer: string): OTR {
  if (!key) throw new Error('OTR identity is not ready');
  const existing = sessions.get(peer);
  if (existing) return existing;
  const otr = new OTR({ priv: key, instance_tag: instanceTag, fragment_size: 1400, send_interval: 12 });
  otr.ALLOW_V2 = true;
  otr.ALLOW_V3 = true;
  otr.REQUIRE_ENCRYPTION = true;
  otr.SEND_WHITESPACE_TAG = false;
  otr.WHITESPACE_START_AKE = true;
  otr.ERROR_START_AKE = true;
  otr.on('io', (body, meta) => {
    const details = (meta ?? {}) as MessageMeta;
    scope.postMessage({ type: 'wire', peer, body, localId: details.localId });
  });
  otr.on('ui', (body, encrypted, meta) => {
    if (!encrypted) return;
    const details = (meta ?? {}) as MessageMeta;
    scope.postMessage({ type: 'message', peer, body, messageId: details.messageId, timestamp: details.timestamp });
  });
  otr.on('status', (status) => {
    if (status === OTR.CONST.STATUS_AKE_SUCCESS) {
      scope.postMessage({ type: 'state', peer, state: 'encrypted', fingerprint: otr.their_priv_pk?.fingerprint() ?? '' });
    } else if (status === OTR.CONST.STATUS_AKE_INIT || status === OTR.CONST.STATUS_SEND_QUERY) {
      scope.postMessage({ type: 'state', peer, state: 'negotiating' });
    } else if (status === OTR.CONST.STATUS_END_OTR) {
      scope.postMessage({ type: 'state', peer, state: 'ended' });
    }
  });
  otr.on('error', (message, severity) => scope.postMessage({ type: 'error', peer, message, severity }));
  sessions.set(peer, otr);
  return otr;
}

scope.onmessage = (event: MessageEvent<Command>) => {
  try {
    const command = event.data;
    if (command.type === 'init') {
      key = command.privateKey ? DSA.parsePrivate(command.privateKey) : new DSA();
      instanceTag = command.instanceTag ? decodeBinary(command.instanceTag) : OTR.makeInstanceTag();
      scope.postMessage({
        type: 'ready',
        privateKey: key.packPrivate(),
        instanceTag: encodeBinary(instanceTag),
        fingerprint: key.fingerprint(),
      });
      return;
    }
    if (command.type === 'reset') {
      for (const otr of sessions.values()) otr.endOtr();
      sessions.clear();
      return;
    }
    const otr = session(command.peer);
    if (command.type === 'start') otr.sendQueryMsg();
    if (command.type === 'send') otr.sendMsg(command.body, { localId: command.localId });
    if (command.type === 'receive') otr.receiveMsg(command.body, { messageId: command.messageId, timestamp: command.timestamp });
    if (command.type === 'end') {
      otr.endOtr();
      sessions.delete(command.peer);
    }
  } catch (reason) {
    scope.postMessage({ type: 'error', message: reason instanceof Error ? reason.message : 'OTR worker failed', severity: 'error' });
  }
};

export {};
