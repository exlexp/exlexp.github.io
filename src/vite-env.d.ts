/// <reference types="vite/client" />

interface DirectSocketOpenInfo {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<BufferSource>;
  localAddress?: string;
  localPort?: number;
}

declare class TCPSocket {
  constructor(remoteAddress: string, remotePort: number, options?: Record<string, unknown>);
  readonly opened: Promise<DirectSocketOpenInfo>;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

interface UDPMessage {
  data: Uint8Array;
  remoteAddress?: string;
  remotePort?: number;
}

declare class UDPSocket {
  constructor(options: Record<string, unknown>);
  readonly opened: Promise<{
    readable: ReadableStream<UDPMessage>;
    writable: WritableStream<UDPMessage | BufferSource>;
    localAddress?: string;
    localPort?: number;
  }>;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}
