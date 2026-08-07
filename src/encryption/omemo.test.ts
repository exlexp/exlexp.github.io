// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import type { OmemoAccountState } from '../models/types';
import type { XmppClient, XmppOmemoPayload } from '../protocols/xmpp/client';
import { parseXmppElement } from '../protocols/xmpp/xml';
import { OmemoEngine, OmemoUnavailableError } from './omemo';

class PepServer {
  private readonly devices = new Map<string, string>();
  private readonly bundles = new Map<string, string>();

  setDevices(jid: string, ids: number[]): void {
    this.devices.set(jid, `<devices xmlns="urn:xmpp:omemo:2">${ids.map((id) => `<device id="${id}"/>`).join('')}</devices>`);
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
          if (node === 'urn:xmpp:omemo:2:devices') this.devices.set(jid, serialized);
          else if (node === 'urn:xmpp:omemo:2:bundles') this.bundles.set(`${jid}:${item.getAttribute('id')}`, serialized);
          return parseXmppElement('<iq type="result"/>');
        }
        const target = options?.to ?? jid;
        const items = root.getElementsByTagNameNS('http://jabber.org/protocol/pubsub', 'items')[0];
        const node = items?.getAttribute('node');
        const id = items?.getElementsByTagNameNS('http://jabber.org/protocol/pubsub', 'item')[0]?.getAttribute('id');
        const value = node === 'urn:xmpp:omemo:2:devices' ? this.devices.get(target) : this.bundles.get(`${target}:${id}`);
        return parseXmppElement(`<iq type="result"><pubsub xmlns="http://jabber.org/protocol/pubsub"><items node="${node}">${value ? `<item id="${id ?? 'current'}">${value}</item>` : ''}</items></pubsub></iq>`);
      },
    } as unknown as XmppClient;
  }
}

function wirePayload(xml: string, ownJid: string, ownDeviceId: number): XmppOmemoPayload {
  const encrypted = parseXmppElement(xml);
  const header = encrypted.getElementsByTagNameNS('urn:xmpp:omemo:2', 'header')[0]!;
  const keys = Array.from(encrypted.getElementsByTagNameNS('urn:xmpp:omemo:2', 'keys')).find((element) => element.getAttribute('jid') === ownJid)!;
  const key = Array.from(keys.getElementsByTagNameNS('urn:xmpp:omemo:2', 'key')).find((element) => Number(element.getAttribute('rid')) === ownDeviceId)!;
  const payload = encrypted.getElementsByTagNameNS('urn:xmpp:omemo:2', 'payload')[0]!;
  return {
    namespace: 'urn:xmpp:omemo:2', senderDeviceId: Number(header.getAttribute('sid')),
    encryptedKey: key.textContent ?? '', keyExchange: key.getAttribute('kex') === 'true', ciphertext: payload.textContent ?? '',
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
});
