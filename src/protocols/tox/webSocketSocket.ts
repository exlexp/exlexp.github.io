import type { ToxSocketFactories } from './socketBridge';

const OPEN_TIMEOUT_MS = 8_000;
const MAX_BUFFERED_BYTES = 1024 * 1024;
let gatewayOffset = 0;

export function gatewaySocketFactories(gateways: readonly string[]): ToxSocketFactories {
  if (!gateways.length) throw new Error('Tox gateway is not configured');
  return {
    tcp: (host, port) => new GatewayTcpSocket(host, port, rotate(gateways)),
    udp: () => { throw new Error('UDP is disabled for browser gateway mode'); },
  };
}

export class GatewayTcpSocket {
  readonly opened: Promise<{ readable: ReadableStream<Uint8Array>; writable: WritableStream<BufferSource> }>;
  private socket: WebSocket | undefined;
  private controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  private closed = false;
  private readonly readable: ReadableStream<Uint8Array>;
  private readonly writable: WritableStream<BufferSource>;

  constructor(private readonly host: string, private readonly port: number, private readonly gateways: readonly string[]) {
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => { this.controller = controller; },
      cancel: () => this.close(),
    });
    this.writable = new WritableStream<BufferSource>({
      write: async (chunk) => {
        await this.opened;
        const socket = this.socket;
        if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Tox gateway socket is closed');
        await waitForCapacity(socket);
        socket.send(copyBuffer(chunk));
      },
      close: () => this.close(),
      abort: () => this.close(),
    });
    this.opened = this.connect();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, 'client closed');
    try { this.controller?.close(); } catch { /* stream already closed */ }
  }

  private async connect(): Promise<{ readable: ReadableStream<Uint8Array>; writable: WritableStream<BufferSource> }> {
    let lastError: unknown;
    for (const gateway of this.gateways) {
      if (this.closed) throw new Error('Tox gateway connection cancelled');
      try {
        this.socket = await openWebSocket(gatewayUrl(gateway, this.host, this.port));
        this.attach(this.socket);
        return { readable: this.readable, writable: this.writable };
      } catch (error) { lastError = error; }
    }
    throw lastError instanceof Error ? lastError : new Error('All Tox gateways are unavailable');
  }

  private attach(socket: WebSocket): void {
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('message', (event) => {
      if (this.closed) return;
      if (event.data instanceof ArrayBuffer) this.controller?.enqueue(new Uint8Array(event.data));
      else if (event.data instanceof Blob) void event.data.arrayBuffer().then((data) => {
        if (!this.closed) this.controller?.enqueue(new Uint8Array(data));
      }).catch(() => this.close());
      else void this.close();
    });
    socket.addEventListener('close', () => this.close());
    socket.addEventListener('error', () => this.close());
  }
}

function openWebSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    const timer = setTimeout(() => fail(new Error('Tox gateway timed out')), OPEN_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener('open', opened);
      socket.removeEventListener('error', failed);
      socket.removeEventListener('close', closed);
    };
    const fail = (error: Error) => {
      cleanup();
      if (socket.readyState < WebSocket.CLOSING) socket.close();
      reject(error);
    };
    const opened = () => { cleanup(); resolve(socket); };
    const failed = () => fail(new Error('Tox gateway rejected the connection'));
    const closed = () => fail(new Error('Tox gateway closed during connection'));
    socket.addEventListener('open', opened, { once: true });
    socket.addEventListener('error', failed, { once: true });
    socket.addEventListener('close', closed, { once: true });
  });
}

function gatewayUrl(base: string, host: string, port: number): string {
  const url = new URL(base);
  url.searchParams.set('host', host);
  url.searchParams.set('port', String(port));
  return url.toString();
}

function rotate<T>(items: readonly T[]): T[] {
  const start = gatewayOffset++ % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}

function copyBuffer(value: BufferSource): ArrayBuffer {
  const source = ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value);
  return source.slice().buffer;
}

async function waitForCapacity(socket: WebSocket): Promise<void> {
  const started = Date.now();
  while (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
    if (socket.readyState !== WebSocket.OPEN) throw new Error('Tox gateway socket closed while sending');
    if (Date.now() - started > OPEN_TIMEOUT_MS) throw new Error('Tox gateway send buffer stalled');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
