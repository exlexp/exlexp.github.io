import { describe, expect, it, vi } from 'vitest';
import { discoverXmppEndpoints, normalizeXmppDomain, xmppDomainFromJid } from './discovery';

describe('XMPP endpoint discovery', () => {
  it('extracts and normalizes a JID domain', () => {
    expect(xmppDomainFromJid('user@Example.Test/mobile')).toBe('example.test');
    expect(() => normalizeXmppDomain('https://example.test/path')).toThrow(/домен/i);
  });

  it('uses a secure WebSocket advertised by host-meta JSON', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ links: [
      { rel: 'urn:xmpp:alt-connections:websocket', href: 'wss://chat.example.test/ws' },
      { rel: 'urn:xmpp:alt-connections:websocket', href: 'ws://unsafe.example.test/ws' },
    ] }), { status: 200 })) as unknown as typeof fetch;
    const result = await discoverXmppEndpoints('example.test', fetcher);
    expect(result.endpoints).toEqual([{ url: 'wss://chat.example.test/ws', source: 'host-meta-json' }]);
  });

  it('falls back to the conventional secure path when metadata is unavailable', async () => {
    const fetcher = vi.fn(async () => { throw new TypeError('CORS'); }) as unknown as typeof fetch;
    const result = await discoverXmppEndpoints('example.test', fetcher);
    expect(result.endpoints[0]?.url).toBe('wss://example.test/xmpp-websocket');
    expect(result.warning).toBe('cors-or-unavailable');
  });

  it('uses the verified xmpp.jp WebSocket and its official signup page immediately', async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const result = await discoverXmppEndpoints('xmpp.jp', fetcher);
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.endpoints).toEqual([{ url: 'wss://api.xmpp.jp/ws/', source: 'provider' }]);
    expect(result.registrationUrl).toBe('https://echo.xmpp.jp/signup');
  });
});
