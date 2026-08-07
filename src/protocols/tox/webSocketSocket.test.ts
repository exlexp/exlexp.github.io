import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayTcpSocket } from './webSocketSocket';

const sockets: FakeWebSocket[] = [];

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  binaryType = 'blob';
  bufferedAmount = 0;
  sent: ArrayBuffer[] = [];

  constructor(url: string) {
    super();
    this.url = url;
    sockets.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.dispatchEvent(new Event('open'));
    });
  }

  send(value: ArrayBuffer): void { this.sent.push(value); }
  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event('close'));
  }
  receive(value: Uint8Array): void {
    this.dispatchEvent(new MessageEvent('message', { data: value.slice().buffer }));
  }
}

describe('Tox WebSocket TCP adapter', () => {
  afterEach(() => { sockets.length = 0; vi.unstubAllGlobals(); });

  it('opens an allowlist-addressed gateway stream and transports binary bytes', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const socket = new GatewayTcpSocket('203.0.113.8', 33445, ['wss://gateway.example/v1/tcp']);
    const { readable, writable } = await socket.opened;
    expect(sockets[0]?.url).toBe('wss://gateway.example/v1/tcp?host=203.0.113.8&port=33445');

    const writer = writable.getWriter();
    await writer.write(Uint8Array.of(1, 2, 3));
    expect([...new Uint8Array(sockets[0]!.sent[0]!)]).toEqual([1, 2, 3]);

    const reader = readable.getReader();
    sockets[0]!.receive(Uint8Array.of(4, 5));
    const incoming = await reader.read();
    expect([...incoming.value!]).toEqual([4, 5]);
    reader.releaseLock();
    writer.releaseLock();
    await socket.close();
  });
});
