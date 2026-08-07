import { afterEach, describe, expect, it, vi } from 'vitest';
import { DirectTcpConnection, DirectUdpConnection, hasDirectSockets } from './directSockets';

describe('Direct Sockets adapters', () => {
  afterEach(() => { Reflect.deleteProperty(globalThis, 'TCPSocket'); Reflect.deleteProperty(globalThis, 'UDPSocket'); });

  it('reports whether both socket APIs are available', () => {
    expect(hasDirectSockets()).toBe(false);
    Object.defineProperty(globalThis, 'TCPSocket', { value: class {}, configurable: true });
    expect(hasDirectSockets()).toBe(false);
    Object.defineProperty(globalThis, 'UDPSocket', { value: class {}, configurable: true });
    expect(hasDirectSockets()).toBe(true);
  });

  it('refuses normal browser environments', async () => {
    await expect(new DirectTcpConnection().connect('127.0.0.1', 33445, 'tox-relay')).rejects.toThrow(/installed IWA/i);
  });

  it('opens, writes, reads, and closes a mocked TCP socket', async () => {
    const write = vi.fn(); const close = vi.fn(async () => undefined);
    class MockTcp {
      opened = Promise.resolve({ readable: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([7])); controller.close(); } }), writable: new WritableStream({ write }) });
      closed = Promise.resolve(); close = close;
    }
    Object.defineProperty(globalThis, 'TCPSocket', { value: MockTcp, configurable: true });
    Object.defineProperty(globalThis, 'UDPSocket', { value: class {}, configurable: true });
    const connection = new DirectTcpConnection(); await connection.connect('127.0.0.1', 33445, 'tox-relay');
    await connection.write(new Uint8Array([1, 2])); expect(await connection.read()).toEqual(new Uint8Array([7])); await connection.close();
    expect(write).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  });

  it('rejects oversized UDP packets', async () => {
    const connection = new DirectUdpConnection();
    await expect(connection.send(new Uint8Array(65_508))).rejects.toThrow(/maximum/i);
  });
});
