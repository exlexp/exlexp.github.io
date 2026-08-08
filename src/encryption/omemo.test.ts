// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import type { OmemoAccountState } from '../models/types';
import type { XmppClient, XmppOmemoPayload } from '../protocols/xmpp/client';
import { parseXmppElement } from '../protocols/xmpp/xml';
import { OmemoEngine, OmemoUnavailableError } from './omemo';

class PepServer {
  private readonly items = new Map<string, string>();
  readonly publications: string[] = [];

  setDevices(jid: string, ids: number[]): void {
    this.items.set(this.key(jid, 'urn:xmpp:omemo:2:devices', 'current'), `<devices xmlns="urn:xmpp:omemo:2">${ids.map((id) => `<device id="${id}"/>`).join('')}</devices>`);
  }

  removeNode(jid: string, node: string): void {
    for (const key of this.items.keys()) if (key.startsWith(`${jid}\u0000${node}\u0000`)) this.items.delete(key);
  }

  getDevices(jid: string, namespace = 'urn:xmpp:omemo:2'): number[] {
    const node = namespace === 'urn:xmpp:omemo:2' ? `${namespace}:devices` : 'eu.siacs.conversations.axolotl.devicelist';
    const xml = this.items.get(this.key(jid, node, 'current'));
    if (!xml) return [];
    const root = parseXmppElement(xml);
    return Array.from(root.getElementsByTagNameNS(namespace, 'device')).map((item) => Number(item.getAttribute('id')));
  }

  private key(jid: string, node: string, id: string): string {
    return `${jid}\u0000${node}\u0000${id}`;
  }

  client(jid: string): XmppClient {
    return {
      setOmemoDeviceId() {},
      requestIq: async (inner: string, options?: { type?: 'get' | 'set'; to?: string }) => {
        const root = parseXmppElement(inner);
        const publish = root.getElementsByTagNameNS('http://jabber.org/protocol/pubsub', 'publish')[0];
        if (options?.type === 'set' && publish) {
          const node = publish.getAttribute('node');
          const item = publish.getElementsByTagNameNS('http://jabber.org/protocol/pubsub', 'item')[0];
          const content = item?.firstElementChild;
          if (!content) throw new Error('empty PEP publication');
          const serialized = new XMLSerializer().serializeToString(content);
          this.items.set(this.key(jid, node ?? '', item.getAttribute('id') ?? 'current'), serialized);
          this.publications.push(node ?? '');
          return parseXmppElement('<iq type="result"/>');
        }
        const target = options?.to ?? jid;
        const items = root.getElementsByTagNameNS('http://jabber.org/protocol/pubsub', 'items')[0];
        const node = items?.getAttribute('node');
        const id = items?.getElementsByTagNameNS('http://jabber.org/protocol/pubsub', 'item')[0]?.getAttribute('id');
        const matched = id
          ? { itemId: id, value: this.items.get(this.key(target, node ?? '', id)) }
          : Array.from(this.items.entries())
            .map(([key, value]) => ({ parts: key.split('\u0000'), value }))
            .filter((entry) => entry.parts[0] === target && entry.parts[1] === node)
            .map((entry) => ({ itemId: entry.parts[2] ?? 'current', value: entry.value }))[0];
        const itemId = matched?.itemId;
        const value = matched?.value;
        return parseXmppElement(`<iq type="result"><pubsub xmlns="http://jabber.org/protocol/pubsub"><items node="${node}">${value ? `<item id="${itemId ?? 'current'}">${value}</item>` : ''}</items></pubsub></iq>`);
      },
    } as unknown as XmppClient;
  }
}

function wirePayload(xml: string, ownJid: string, ownDeviceId: number): XmppOmemoPayload {
  const encrypted = parseXmppElement(xml);
  const namespace = encrypted.namespaceURI as XmppOmemoPayload['namespace'];
  const header = encrypted.getElementsByTagNameNS(namespace, 'header')[0]!;
  const keyRoot = namespace === 'urn:xmpp:omemo:2'
    ? Array.from(encrypted.getElementsByTagNameNS(namespace, 'keys')).find((element) => element.getAttribute('jid') === ownJid)!
    : header;
  const key = Array.from(keyRoot.getElementsByTagNameNS(namespace, 'key')).find((element) => Number(element.getAttribute('rid')) === ownDeviceId)!;
  const payload = encrypted.getElementsByTagNameNS(namespace, 'payload')[0]!;
  return {
    namespace, senderDeviceId: Number(header.getAttribute('sid')),
    encryptedKey: key.textContent ?? '',
    keyExchange: namespace === 'urn:xmpp:omemo:2' ? key.getAttribute('kex') === 'true' : key.getAttribute('prekey') === 'true',
    ciphertext: payload.textContent ?? '',
    iv: namespace === 'eu.siacs.conversations.axolotl'
      ? header.getElementsByTagNameNS(namespace, 'iv')[0]?.textContent ?? undefined
      : undefined,
  };
}

describe('OMEMO engine', () => {
  it('publishes bundles, establishes sessions, encrypts, decrypts, and persists ratchets', async () => {
    const dom = new JSDOM('');
    Object.assign(globalThis, { DOMParser: dom.window.DOMParser, XMLSerializer: dom.window.XMLSerializer });
    const pep = new PepServer();
    let aliceState: OmemoAccountState | undefined;
    let bobState: OmemoAccountState | undefined;
    const alice = await OmemoEngine.open(pep.client('alice@example.test'), 'alice@example.test', undefined, async (state) => { aliceState = state; });
    const bob = await OmemoEngine.open(pep.client('bob@example.test'), 'bob@example.test', undefined, async (state) => { bobState = state; });
    await alice.announce();
    await bob.announce();

    const outbound = await alice.encrypt('bob@example.test', 'secret <message>');
    expect(outbound.xml).not.toContain('secret');
    const decrypted = await bob.decrypt('alice@example.test', wirePayload(outbound.xml, 'bob@example.test', bob.deviceId));
    expect(decrypted.body).toBe('secret <message>');
    expect(decrypted.fingerprint).toMatch(/[0-9a-f]{8}/);
    expect(aliceState?.store).toBeTruthy();
    expect(bobState?.store).toBeTruthy();
  }, 30_000);

  it('refreshes the list and skips an orphaned device without aborting reachable recipients', async () => {
    const dom = new JSDOM('');
    Object.assign(globalThis, { DOMParser: dom.window.DOMParser, XMLSerializer: dom.window.XMLSerializer });
    const pep = new PepServer();
    const alice = await OmemoEngine.open(pep.client('alice@example.test'), 'alice@example.test', undefined, async () => undefined);
    const bob = await OmemoEngine.open(pep.client('bob@example.test'), 'bob@example.test', undefined, async () => undefined);
    await alice.announce();
    await bob.announce();
    pep.setDevices('bob@example.test', [bob.deviceId, 424242]);

    const outbound = await alice.encrypt('bob@example.test', 'still encrypted');

    expect(outbound.devices.some((device) => device.jid === 'bob@example.test' && device.deviceId === bob.deviceId)).toBe(true);
    expect(outbound.skippedDevices).toContainEqual({ jid: 'bob@example.test', deviceId: 424242 });
    expect(outbound.xml).not.toContain('still encrypted');
  }, 30_000);

  it('refuses to send when every advertised recipient device is orphaned', async () => {
    const dom = new JSDOM('');
    Object.assign(globalThis, { DOMParser: dom.window.DOMParser, XMLSerializer: dom.window.XMLSerializer });
    const pep = new PepServer();
    const alice = await OmemoEngine.open(pep.client('alice@example.test'), 'alice@example.test', undefined, async () => undefined);
    await alice.announce();
    pep.setDevices('bob@example.test', [424242]);

    await expect(alice.encrypt('bob@example.test', 'must not leak')).rejects.toBeInstanceOf(OmemoUnavailableError);
  }, 30_000);

  it('re-announces itself when another client overwrites its own device list', async () => {
    const dom = new JSDOM('');
    Object.assign(globalThis, { DOMParser: dom.window.DOMParser, XMLSerializer: dom.window.XMLSerializer });
    const pep = new PepServer();
    const alice = await OmemoEngine.open(pep.client('alice@example.test'), 'alice@example.test', undefined, async () => undefined);
    await alice.announce();
    pep.setDevices('alice@example.test', [123456]);
    pep.publications.length = 0;

    await alice.updateDeviceList('alice@example.test', [123456]);

    expect(pep.getDevices('alice@example.test')).toEqual(expect.arrayContaining([123456, alice.deviceId]));
    expect(pep.publications.slice(-2)).toEqual(['urn:xmpp:omemo:2:bundles', 'urn:xmpp:omemo:2:devices']);
  }, 30_000);

  it('interoperates bidirectionally with a Dino-style legacy-only OMEMO peer', async () => {
    const dom = new JSDOM('');
    Object.assign(globalThis, { DOMParser: dom.window.DOMParser, XMLSerializer: dom.window.XMLSerializer });
    const pep = new PepServer();
    let aliceState: OmemoAccountState | undefined;
    let bobState: OmemoAccountState | undefined;
    const alice = await OmemoEngine.open(pep.client('alice@example.test'), 'alice@example.test', undefined, async (state) => { aliceState = state; });
    const bob = await OmemoEngine.open(pep.client('bob@example.test'), 'bob@example.test', undefined, async (state) => { bobState = state; });
    await alice.announce();
    await bob.announce();
    pep.removeNode('alice@example.test', 'urn:xmpp:omemo:2:devices');
    pep.removeNode('bob@example.test', 'urn:xmpp:omemo:2:devices');

    const outbound = await alice.encrypt('bob@example.test', 'hello Dino');
    expect(outbound.namespace).toBe('eu.siacs.conversations.axolotl');
    expect(outbound.xml).toContain('prekey="true"');
    expect(outbound.xml).not.toContain('hello Dino');
    await expect(bob.decrypt('alice@example.test', wirePayload(outbound.xml, 'bob@example.test', bob.deviceId)))
      .resolves.toMatchObject({ body: 'hello Dino' });

    const reply = await bob.encrypt('alice@example.test', 'hello Relayless');
    expect(reply.namespace).toBe('eu.siacs.conversations.axolotl');
    await expect(alice.decrypt('bob@example.test', wirePayload(reply.xml, 'alice@example.test', alice.deviceId)))
      .resolves.toMatchObject({ body: 'hello Relayless' });
    expect(aliceState?.legacyStore).toBeTruthy();
    expect(bobState?.legacyStore).toBeTruthy();
  }, 30_000);
});
