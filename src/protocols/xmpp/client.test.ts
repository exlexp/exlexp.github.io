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

  it('keeps offline delivery while declining permanent server archives by default', () => {
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
    expect(sent[0]).toContain('<no-permanent-store');
    expect(sent[0]).not.toContain('<store');
    expect(sent[0]).not.toContain('chatstates');
  });

  it('requests server archiving only after explicit consent', () => {
    const sent: string[] = [];
    const client = new XmppClient();
    const harness = client as unknown as { bound: boolean; socket: { readyState: number; send(value: string): void } };
    harness.bound = true;
    harness.socket = { readyState: WebSocket.OPEN, send: (value) => sent.push(value) };
    client.sendMessage('friend@example.org', 'archived', true);
    expect(sent[0]).toContain('<store');
    expect(sent[0]).not.toContain('no-permanent-store');
  });

  it('routes OTR only to a full JID and disables server-side copies', () => {
    const sent: string[] = [];
    const client = new XmppClient();
    const harness = client as unknown as { bound: boolean; socket: { readyState: number; send(value: string): void } };
    harness.bound = true;
    harness.socket = { readyState: WebSocket.OPEN, send: (value) => sent.push(value) };
    expect(() => client.sendOtrMessage('friend@example.org', '?OTRv23?')).toThrow(/specific online XMPP resource/i);
    client.sendOtrMessage('friend@example.org/dino', '?OTRv23?');
    expect(sent[0]).toContain('to="friend@example.org/dino"');
    expect(sent[0]).toContain('namespace="urn:xmpp:otr:0"');
    expect(sent[0]).toContain('<no-copy');
    expect(sent[0]).toContain('<no-permanent-store');
    expect(sent[0]).toContain('<private');
    expect(sent[0]).not.toContain('<request');
  });

  it('separates incoming OTR protocol frames from visible chat messages', async () => {
    const client = new XmppClient();
    const events: unknown[] = [];
    client.subscribe((event) => events.push(event));
    const harness = client as unknown as { handleFrame(xml: string): Promise<void> };
    await harness.handleFrame('<message from="friend@example.org/dino" to="me@example.org/relayless" type="chat" id="otr-1"><body>?OTRv23?</body></message>');
    expect(events).toContainEqual({
      type: 'otr-wire', id: 'otr-1', from: 'friend@example.org', peer: 'friend@example.org/dino',
      body: '?OTRv23?', timestamp: expect.any(Number),
    });
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'message', id: 'otr-1' }));
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
    expect(sent[0]).toContain('<no-permanent-store');
  });

  it('adds the fixed compatibility body used by Dino for legacy OMEMO', () => {
    const sent: string[] = [];
    const client = new XmppClient();
    const harness = client as unknown as { bound: boolean; socket: { readyState: number; send(value: string): void } };
    harness.bound = true;
    harness.socket = { readyState: WebSocket.OPEN, send: (value) => sent.push(value) };
    client.sendEncryptedMessage('friend@example.org', '<encrypted xmlns="eu.siacs.conversations.axolotl"/>', 'eu.siacs.conversations.axolotl');
    expect(sent[0]).toContain('namespace="eu.siacs.conversations.axolotl"');
    expect(sent[0]).toContain('<body>[This message is OMEMO encrypted]</body>');
  });

  it('updates OMEMO device lists from PEP pushes', async () => {
    const client = new XmppClient();
    const events: unknown[] = [];
    client.subscribe((event) => events.push(event));
    const harness = client as unknown as { handleFrame(xml: string): Promise<void> };
    await harness.handleFrame('<message from="friend@example.org" type="headline"><event xmlns="http://jabber.org/protocol/pubsub#event"><items node="urn:xmpp:omemo:2:devices"><item id="current"><devices xmlns="urn:xmpp:omemo:2"><device id="7"/><device id="11"/></devices></item></items></event></message>');
    expect(events).toContainEqual({ type: 'omemo-devices', from: 'friend@example.org', namespace: 'urn:xmpp:omemo:2', deviceIds: [7, 11] });
  });

  it('answers server XEP-0199 pings so the WebSocket is not treated as idle', async () => {
    const sent: string[] = [];
    const client = new XmppClient();
    const harness = client as unknown as {
      socket: { readyState: number; send(value: string): void };
      handleFrame(xml: string): Promise<void>;
    };
    harness.socket = { readyState: WebSocket.OPEN, send: (value) => sent.push(value) };
    await harness.handleFrame('<iq from="example.org" type="get" id="keepalive-1"><ping xmlns="urn:xmpp:ping"/></iq>');
    expect(sent).toContain('<iq type="result" id="keepalive-1" to="example.org"/>');
  });

  it('parses Dino-compatible legacy OMEMO device notifications', async () => {
    const client = new XmppClient();
    const events: unknown[] = [];
    client.subscribe((event) => events.push(event));
    const harness = client as unknown as { handleFrame(xml: string): Promise<void> };
    await harness.handleFrame('<message from="friend@example.org" type="headline"><event xmlns="http://jabber.org/protocol/pubsub#event"><items node="eu.siacs.conversations.axolotl.devicelist"><item id="current"><list xmlns="eu.siacs.conversations.axolotl"><device id="23"/></list></item></items></event></message>');
    expect(events).toContainEqual({ type: 'omemo-devices', from: 'friend@example.org', namespace: 'eu.siacs.conversations.axolotl', deviceIds: [23] });
  });

  it('extracts a Dino-style legacy OMEMO envelope addressed to this device', async () => {
    const client = new XmppClient();
    const events: unknown[] = [];
    client.subscribe((event) => events.push(event));
    client.setOmemoDeviceId(23);
    const harness = client as unknown as {
      credentials: { jid: string };
      handleFrame(xml: string): Promise<void>;
    };
    harness.credentials = { jid: 'me@example.org' };
    await harness.handleFrame('<message from="friend@example.org/dino" to="me@example.org/relayless" type="chat" id="dino-1"><encrypted xmlns="eu.siacs.conversations.axolotl"><header sid="71"><key rid="23" prekey="true">a2V5</key><iv>aXY=</iv></header><payload>Y2lwaGVydGV4dA==</payload></encrypted><body>[This message is OMEMO encrypted]</body></message>');
    expect(events).toContainEqual({
      type: 'encrypted-message', id: 'dino-1', from: 'friend@example.org', timestamp: expect.any(Number), archived: false,
      payload: {
        namespace: 'eu.siacs.conversations.axolotl', senderDeviceId: 71, encryptedKey: 'a2V5', keyExchange: true,
        ciphertext: 'Y2lwaGVydGV4dA==', iv: 'aXY=',
      },
    });
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
