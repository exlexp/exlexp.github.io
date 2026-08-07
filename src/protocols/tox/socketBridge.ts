const MAX_DATAGRAM_BYTES = 65_507;
const MAX_QUEUE_BYTES = 1024 * 1024;
const MAX_QUEUE_ITEMS = 512;

type SocketState = 'created' | 'opening' | 'open' | 'closed' | 'error';

interface SocketActivity {
  handle: number;
  transport: 'udp' | 'tcp';
  state: SocketState;
  host?: string;
  port?: number;
}

interface OpenedTcpSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<BufferSource>;
}

interface OpenedUdpSocket {
  readable: ReadableStream<UDPMessage>;
  writable: WritableStream<UDPMessage | BufferSource>;
}

interface ClosableSocket<T> {
  opened: Promise<T>;
  close(): Promise<void>;
}

export interface ToxSocketFactories {
  tcp(host: string, port: number): ClosableSocket<OpenedTcpSocket>;
  udp(options: Record<string, unknown>): ClosableSocket<OpenedUdpSocket>;
}

interface BaseRecord {
  handle: number;
  state: SocketState;
  host?: string;
  port?: number;
  queuedBytes: number;
  writing: boolean;
}

interface TcpRecord extends BaseRecord {
  transport: 'tcp';
  socket?: ClosableSocket<OpenedTcpSocket>;
  writer?: WritableStreamDefaultWriter<BufferSource>;
  incoming: Uint8Array[];
  outgoing: Uint8Array[];
}

interface UdpPacket {
  data: Uint8Array;
  remoteAddress: string;
  remotePort: number;
}

interface UdpRecord extends BaseRecord {
  transport: 'udp';
  family: number;
  socket?: ClosableSocket<OpenedUdpSocket>;
  writer?: WritableStreamDefaultWriter<UDPMessage | BufferSource>;
  incoming: UdpPacket[];
  outgoing: UdpPacket[];
}

type SocketRecord = TcpRecord | UdpRecord;

export class ToxSocketBridge {
  private readonly sockets = new Map<number, SocketRecord>();
  private nextHandle = 1;

  constructor(
    private readonly factories: ToxSocketFactories = browserSocketFactories,
    private readonly onActivity: (activity: SocketActivity) => void = () => undefined,
  ) {}

  socket(_domain: number, type: number, _protocol: number): number {
    const handle = this.nextHandle++;
    const base = { handle, state: 'created' as const, queuedBytes: 0, writing: false };
    const record: SocketRecord = type === 1
      ? { ...base, transport: 'tcp', incoming: [], outgoing: [] }
      : { ...base, transport: 'udp', family: 2, incoming: [], outgoing: [] };
    this.sockets.set(handle, record);
    this.emit(record);
    return handle;
  }

  bind(handle: number, family: number, port: number): number {
    const record = this.sockets.get(handle);
    if (!record || record.transport !== 'udp' || record.state !== 'created') return -1;
    record.family = family;
    record.port = port;
    record.state = 'opening';
    this.emit(record);
    const localAddress = family === 10 ? '::' : '0.0.0.0';
    try {
      record.socket = this.factories.udp({ localAddress, localPort: port });
      void record.socket.opened.then(({ readable, writable }) => {
        if (record.state === 'closed') return;
        record.writer = writable.getWriter();
        record.state = 'open';
        this.emit(record);
        void this.readUdp(record, readable.getReader());
        void this.drainUdp(record);
      }).catch(() => this.markError(record));
      return 0;
    } catch { this.markError(record); return -1; }
  }

  connect(handle: number, host: string, port: number): number {
    const record = this.sockets.get(handle);
    if (!record || record.transport !== 'tcp' || record.state !== 'created') return -1;
    if (!validRemote(host, port)) return -1;
    record.host = host; record.port = port; record.state = 'opening'; this.emit(record);
    try {
      record.socket = this.factories.tcp(host, port);
      void record.socket.opened.then(({ readable, writable }) => {
        if (record.state === 'closed') return;
        record.writer = writable.getWriter(); record.state = 'open'; this.emit(record);
        void this.readTcp(record, readable.getReader());
        void this.drainTcp(record);
      }).catch(() => this.markError(record));
      return 0;
    } catch { this.markError(record); return -1; }
  }

  send(handle: number, data: Uint8Array): number {
    const record = this.sockets.get(handle);
    if (!record || record.transport !== 'tcp' || !queueAllowed(record, data.byteLength)) return -1;
    const copy = data.slice(); record.outgoing.push(copy); record.queuedBytes += copy.byteLength;
    void this.drainTcp(record);
    return copy.byteLength;
  }

  sendTo(handle: number, data: Uint8Array, remoteAddress: string, remotePort: number): number {
    const record = this.sockets.get(handle);
    if (!record || record.transport !== 'udp' || data.byteLength > MAX_DATAGRAM_BYTES || !validRemote(remoteAddress, remotePort) || !queueAllowed(record, data.byteLength)) return -1;
    const packet = { data: data.slice(), remoteAddress, remotePort };
    record.outgoing.push(packet); record.queuedBytes += packet.data.byteLength;
    void this.drainUdp(record);
    return packet.data.byteLength;
  }

  receive(handle: number, maximum: number): Uint8Array | undefined {
    const record = this.sockets.get(handle);
    if (!record || record.transport !== 'tcp' || maximum <= 0) return undefined;
    const first = record.incoming[0];
    if (!first) return undefined;
    if (first.byteLength <= maximum) { record.incoming.shift(); return first; }
    const result = first.slice(0, maximum);
    record.incoming[0] = first.slice(maximum);
    return result;
  }

  receiveFrom(handle: number, maximum: number): UdpPacket | undefined {
    const record = this.sockets.get(handle);
    if (!record || record.transport !== 'udp' || maximum <= 0) return undefined;
    while (record.incoming.length > 0) {
      const packet = record.incoming.shift();
      if (packet && packet.data.byteLength <= maximum) return packet;
    }
    return undefined;
  }

  receiveBufferSize(handle: number): number {
    const record = this.sockets.get(handle);
    if (!record) return 0;
    return record.incoming.reduce((total, item) => total + ('data' in item ? item.data.byteLength : item.byteLength), 0);
  }

  state(handle: number): SocketState | undefined { return this.sockets.get(handle)?.state; }

  close(handle: number): number {
    const record = this.sockets.get(handle);
    if (!record) return -1;
    record.state = 'closed'; record.incoming.length = 0; record.outgoing.length = 0; record.queuedBytes = 0; this.emit(record);
    void record.writer?.abort().catch(() => undefined);
    void record.socket?.close().catch(() => undefined);
    this.sockets.delete(handle);
    return 0;
  }

  async shutdown(): Promise<void> {
    const records = [...this.sockets.values()];
    for (const record of records) this.close(record.handle);
    await Promise.all(records.map((record) => record.socket?.close().catch(() => undefined)));
  }

  private async readTcp(record: TcpRecord, reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    try {
      while (record.state === 'open') {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.byteLength && incomingSize(record) + value.byteLength <= MAX_QUEUE_BYTES && record.incoming.length < MAX_QUEUE_ITEMS) record.incoming.push(value.slice());
      }
      if (record.state === 'open') this.markError(record);
    } catch { if (record.state !== 'closed') this.markError(record); }
    finally { reader.releaseLock(); }
  }

  private async readUdp(record: UdpRecord, reader: ReadableStreamDefaultReader<UDPMessage>): Promise<void> {
    try {
      while (record.state === 'open') {
        const { done, value } = await reader.read();
        if (done) break;
        const data = new Uint8Array(value.data);
        if (data.byteLength <= MAX_DATAGRAM_BYTES && value.remoteAddress && value.remotePort && incomingSize(record) + data.byteLength <= MAX_QUEUE_BYTES && record.incoming.length < MAX_QUEUE_ITEMS) {
          record.incoming.push({ data: data.slice(), remoteAddress: value.remoteAddress, remotePort: value.remotePort });
        }
      }
      if (record.state === 'open') this.markError(record);
    } catch { if (record.state !== 'closed') this.markError(record); }
    finally { reader.releaseLock(); }
  }

  private async drainTcp(record: TcpRecord): Promise<void> {
    if (record.writing || record.state !== 'open' || !record.writer) return;
    record.writing = true;
    try {
      while (record.outgoing.length > 0 && record.state === 'open') {
        const data = record.outgoing.shift(); if (!data) break;
        record.queuedBytes -= data.byteLength;
        await record.writer.write(new Uint8Array(data).buffer);
      }
    } catch { this.markError(record); }
    finally { record.writing = false; }
  }

  private async drainUdp(record: UdpRecord): Promise<void> {
    if (record.writing || record.state !== 'open' || !record.writer) return;
    record.writing = true;
    try {
      while (record.outgoing.length > 0 && record.state === 'open') {
        const packet = record.outgoing.shift(); if (!packet) break;
        record.queuedBytes -= packet.data.byteLength;
        await record.writer.write({ data: packet.data, remoteAddress: packet.remoteAddress, remotePort: packet.remotePort });
      }
    } catch { this.markError(record); }
    finally { record.writing = false; }
  }

  private markError(record: SocketRecord): void {
    if (record.state === 'closed') return;
    record.state = 'error'; this.emit(record);
  }

  private emit(record: SocketRecord): void {
    this.onActivity({ handle: record.handle, transport: record.transport, state: record.state, host: record.host, port: record.port });
  }
}

function queueAllowed(record: SocketRecord, length: number): boolean {
  return length > 0 && record.state !== 'closed' && record.state !== 'error' && record.outgoing.length < MAX_QUEUE_ITEMS && record.queuedBytes + length <= MAX_QUEUE_BYTES;
}

function incomingSize(record: SocketRecord): number {
  return record.incoming.reduce((total, item) => total + ('data' in item ? item.data.byteLength : item.byteLength), 0);
}

function validRemote(host: string, port: number): boolean {
  return Boolean(host.trim()) && Number.isInteger(port) && port > 0 && port <= 65_535;
}

const browserSocketFactories: ToxSocketFactories = {
  tcp: (host, port) => new TCPSocket(host, port, { keepAlive: true, noDelay: true }),
  udp: (options) => new UDPSocket(options),
};
