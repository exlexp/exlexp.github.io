import { describe, expect, it } from 'vitest';
import { ToxSocketBridge, type ToxSocketFactories } from './socketBridge';

function factories(): ToxSocketFactories {
  return {
    tcp: () => ({
      opened: Promise.resolve({ readable: new ReadableStream<Uint8Array>(), writable: new WritableStream<BufferSource>() }),
      close: async () => undefined,
    }),
    udp: () => ({
      opened: Promise.resolve({ readable: new ReadableStream<UDPMessage>(), writable: new WritableStream<UDPMessage | BufferSource>() }),
      close: async () => undefined,
    }),
  };
}

describe('Tox Direct Sockets bridge', () => {
  it('creates isolated numeric handles and opens UDP/TCP asynchronously', async () => {
    const bridge = new ToxSocketBridge(factories());
    const udp = bridge.socket(2, 2, 2);
    const tcp = bridge.socket(2, 1, 1);
    expect(tcp).not.toBe(udp);
    expect(bridge.bind(udp, 2, 0)).toBe(0);
    expect(bridge.connect(tcp, '203.0.113.8', 33445)).toBe(0);
    await Promise.resolve(); await Promise.resolve();
    expect(bridge.state(udp)).toBe('open');
    expect(bridge.state(tcp)).toBe('open');
    await bridge.shutdown();
  });

  it('bounds outbound queues and rejects oversized datagrams', () => {
    const bridge = new ToxSocketBridge(factories());
    const udp = bridge.socket(2, 2, 2);
    expect(bridge.sendTo(udp, new Uint8Array(65_508), '203.0.113.8', 33445)).toBe(-1);
    const packet = new Uint8Array(4096);
    let accepted = 0;
    while (bridge.sendTo(udp, packet, '203.0.113.8', 33445) > 0) accepted += 1;
    expect(accepted).toBeLessThanOrEqual(256);
  });

  it('closes handles deterministically', () => {
    const bridge = new ToxSocketBridge(factories());
    const handle = bridge.socket(2, 1, 1);
    expect(bridge.close(handle)).toBe(0);
    expect(bridge.state(handle)).toBeUndefined();
    expect(bridge.close(handle)).toBe(-1);
  });
});
