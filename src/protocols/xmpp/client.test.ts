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
});
