import { describe, expect, it } from 'vitest';
import { XmppClient } from './client';

describe('XMPP client contact flow', () => {
  it('adds a roster item and sends a presence subscription', () => {
    const sent: string[] = [];
    const client = new XmppClient();
    const harness = client as unknown as { bound: boolean; socket: { readyState: number; send(value: string): void } };
    harness.bound = true;
    harness.socket = { readyState: WebSocket.OPEN, send: (value) => sent.push(value) };
    expect(client.addContact('friend@example.org', 'Friend & Team')).toBe('friend@example.org');
    expect(sent[0]).toContain('jabber:iq:roster');
    expect(sent[0]).toContain('name="Friend &amp; Team"');
    expect(sent[1]).toContain('type="subscribe"');
  });

  it('refuses malformed JIDs', () => {
    const client = new XmppClient();
    const harness = client as unknown as { bound: boolean; socket: { readyState: number; send(value: string): void } };
    harness.bound = true;
    harness.socket = { readyState: WebSocket.OPEN, send: () => undefined };
    expect(() => client.addContact('missing-domain')).toThrow(/complete contact JID/i);
  });

  it('sends reliable TLS chat stanzas with receipts and offline storage', () => {
    const sent: string[] = [];
    const client = new XmppClient();
    const harness = client as unknown as { bound: boolean; socket: { readyState: number; send(value: string): void } };
    harness.bound = true;
    harness.socket = { readyState: WebSocket.OPEN, send: (value) => sent.push(value) };
    const id = client.sendMessage('friend@example.org', 'hello & goodbye');
    expect(sent[0]).toContain(`id="${id}"`);
    expect(sent[0]).toContain('<body>hello &amp; goodbye</body>');
    expect(sent[0]).toContain('urn:xmpp:receipts');
    expect(sent[0]).toContain('urn:xmpp:hints');
    expect(sent[0]).toContain('<store');
    expect(sent[0]).not.toContain('no-store');
  });

  it('marks OMEMO 2 messages for interoperable encryption discovery', () => {
    const sent: string[] = [];
    const client = new XmppClient();
    const harness = client as unknown as { bound: boolean; socket: { readyState: number; send(value: string): void } };
    harness.bound = true;
    harness.socket = { readyState: WebSocket.OPEN, send: (value) => sent.push(value) };
    client.sendEncryptedMessage('friend@example.org', '<encrypted xmlns="urn:xmpp:omemo:2"/>');
    expect(sent[0]).toContain('xmlns="urn:xmpp:eme:0"');
    expect(sent[0]).toContain('namespace="urn:xmpp:omemo:2"');
    expect(sent[0]).not.toContain('<body>');
  });

  it('updates OMEMO device lists from PEP pushes', async () => {
    const client = new XmppClient();
    const events: unknown[] = [];
    client.subscribe((event) => events.push(event));
    const harness = client as unknown as { handleFrame(xml: string): Promise<void> };
    await harness.handleFrame('<message from="friend@example.org" type="headline"><event xmlns="http://jabber.org/protocol/pubsub#event"><items node="urn:xmpp:omemo:2:devices"><item id="current"><devices xmlns="urn:xmpp:omemo:2"><device id="7"/><device id="11"/></devices></item></items></event></message>');
    expect(events).toContainEqual({ type: 'omemo-devices', from: 'friend@example.org', deviceIds: [7, 11] });
  });

  it('removes a roster contact and both subscription directions', () => {
    const sent: string[] = [];
    const client = new XmppClient();
    const harness = client as unknown as { bound: boolean; socket: { readyState: number; send(value: string): void } };
    harness.bound = true;
    harness.socket = { readyState: WebSocket.OPEN, send: (value) => sent.push(value) };
    client.removeContact('friend@example.org');
    expect(sent.join(' ')).toContain('type="unsubscribe"');
    expect(sent.join(' ')).toContain('type="unsubscribed"');
    expect(sent.join(' ')).toContain('subscription="remove"');
  });
});
