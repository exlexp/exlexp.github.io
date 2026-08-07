import { afterEach, describe, expect, it, vi } from 'vitest';
import { privateFetch, privateWebSocket } from './privateTransport';

describe('private browser transports', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('never sends credentials or a referrer during XMPP discovery', async () => {
    const implementation = vi.fn(async () => new Response('{}')) as unknown as typeof fetch;
    await privateFetch('https://chat.example/.well-known/host-meta.json', {}, 'xmpp-discovery', implementation);
    expect(implementation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      credentials: 'omit', referrerPolicy: 'no-referrer',
    }));
  });

  it('rejects insecure or credential-bearing remote transports', () => {
    const implementation = vi.fn() as unknown as typeof fetch;
    expect(() => privateFetch('http://chat.example/meta', {}, 'xmpp-discovery', implementation)).toThrow(/HTTPS/);
    expect(() => privateWebSocket('wss://name:secret@chat.example/xmpp', 'xmpp', 'xmpp-provider')).toThrow(/Unsafe/);
    expect(() => privateWebSocket('ws://chat.example/xmpp', 'xmpp', 'xmpp-provider')).toThrow(/secure WebSockets/);
  });

  it('permits an insecure Tox gateway only on loopback development hosts', () => {
    class SocketStub { constructor(readonly url: URL | string) {} }
    vi.stubGlobal('WebSocket', SocketStub);
    expect(privateWebSocket('ws://127.0.0.1:8787/v1/tcp', undefined, 'tox-gateway')).toBeInstanceOf(SocketStub);
    expect(() => privateWebSocket('ws://gateway.example/v1/tcp', undefined, 'tox-gateway')).toThrow(/secure WebSockets/);
  });
});
