import { networkPolicy } from './policy';

const MAX_PACKET_BYTES = 65_507;

export function hasDirectSockets(): boolean {
  return typeof TCPSocket === 'function' && typeof UDPSocket === 'function';
}

export class DirectTcpConnection {
  private socket: TCPSocket | undefined;
  private activityId: string | undefined;
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  private writer: WritableStreamDefaultWriter<BufferSource> | undefined;

  async connect(host: string, port: number, kind: 'tox-relay' | 'tox-peer'): Promise<void> {
    if (!hasDirectSockets()) throw new Error('Direct Sockets are available only inside an installed IWA');
    this.activityId = networkPolicy.open({
      protocol: 'TOX', destination: host, port, kind, source: 'bundled-public-node',
    });
    try {
      this.socket = new TCPSocket(host, port, { keepAlive: true, noDelay: true });
      const { readable, writable } = await this.socket.opened;
      this.reader = readable.getReader();
      this.writer = writable.getWriter();
      networkPolicy.setState(this.activityId, 'open');
    } catch (error) {
      networkPolicy.setState(this.activityId, 'failed');
      throw error;
    }
  }

  async read(): Promise<Uint8Array | undefined> {
    if (!this.reader) throw new Error('TCP socket is not connected');
    const { done, value } = await this.reader.read();
    return done ? undefined : value;
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.writer) throw new Error('TCP socket is not connected');
    await this.writer.write(data.slice().buffer);
  }

  async close(): Promise<void> {
    await this.reader?.cancel().catch(() => undefined);
    await this.writer?.close().catch(() => undefined);
    await this.socket?.close().catch(() => undefined);
    if (this.activityId) networkPolicy.setState(this.activityId, 'closed');
    this.reader = undefined;
    this.writer = undefined;
    this.socket = undefined;
  }
}

export class DirectUdpConnection {
  private socket: UDPSocket | undefined;
  private reader: ReadableStreamDefaultReader<UDPMessage> | undefined;
  private writer: WritableStreamDefaultWriter<UDPMessage | BufferSource> | undefined;
  private activityId: string | undefined;

  async bind(remoteHost: string, remotePort: number): Promise<void> {
    if (!hasDirectSockets()) throw new Error('Direct Sockets are available only inside an installed IWA');
    this.activityId = networkPolicy.open({
      protocol: 'TOX', destination: remoteHost, port: remotePort, kind: 'tox-bootstrap', source: 'bundled-public-node',
    });
    try {
      this.socket = new UDPSocket({ remoteAddress: remoteHost, remotePort });
      const { readable, writable } = await this.socket.opened;
      this.reader = readable.getReader();
      this.writer = writable.getWriter();
      networkPolicy.setState(this.activityId, 'open');
    } catch (error) {
      networkPolicy.setState(this.activityId, 'failed');
      throw error;
    }
  }

  async send(data: Uint8Array): Promise<void> {
    if (data.byteLength > MAX_PACKET_BYTES) throw new Error('UDP packet exceeds the safe maximum size');
    if (!this.writer) throw new Error('UDP socket is not connected');
    await this.writer.write(data.slice().buffer);
  }

  async receive(): Promise<UDPMessage | undefined> {
    if (!this.reader) throw new Error('UDP socket is not connected');
    const { done, value } = await this.reader.read();
    if (value && value.data.byteLength > MAX_PACKET_BYTES) throw new Error('Oversized UDP packet rejected');
    return done ? undefined : value;
  }

  async close(): Promise<void> {
    await this.reader?.cancel().catch(() => undefined);
    await this.writer?.close().catch(() => undefined);
    await this.socket?.close().catch(() => undefined);
    if (this.activityId) networkPolicy.setState(this.activityId, 'closed');
    this.reader = undefined;
    this.writer = undefined;
    this.socket = undefined;
  }
}
