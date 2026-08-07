import type { ToxBootstrapNode, ToxCommand, ToxEvent, ToxWorkerRequest, ToxWorkerResponse } from './types';
import { toxGatewayUrls } from './gatewayConfig';

type Listener = (event: ToxEvent) => void;

interface BootstrapDocument {
  nodes: ToxBootstrapNode[];
}

export class ToxClient {
  private readonly worker = new Worker(new URL('./tox.worker.ts', import.meta.url), { type: 'module', name: 'relayless-toxcore' });
  private readonly listeners = new Set<Listener>();
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private requestId = 0;
  private stopped = false;

  constructor() {
    this.worker.addEventListener('message', (message: MessageEvent<ToxWorkerResponse>) => this.receive(message.data));
    this.worker.addEventListener('error', () => this.emit({ type: 'state', state: 'error', detail: 'Tox worker stopped unexpectedly' }));
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(options: { savedata?: string; name: string; status?: string }): Promise<void> {
    const response = await fetch(`${import.meta.env.BASE_URL}tox-bootstrap-nodes.json`, { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) throw new Error('Bundled Tox bootstrap list is unavailable');
    const document = await response.json() as BootstrapDocument;
    validateNodes(document.nodes);
    await this.call({
      type: 'start', savedata: options.savedata, name: options.name, status: options.status ?? '',
      nodes: document.nodes, gatewayUrls: toxGatewayUrls(),
    });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    await this.call({ type: 'stop' }).catch(() => undefined);
    this.stopped = true;
    this.worker.terminate();
    for (const operation of this.pending.values()) operation.reject(new Error('Tox client stopped'));
    this.pending.clear();
  }

  setProfile(name: string, status: string): Promise<void> { return this.call({ type: 'set-profile', name, status }); }
  addFriend(address: string, message: string): Promise<number> { return this.call({ type: 'add-friend', address, message }); }
  acceptFriend(publicKey: string): Promise<number> { return this.call({ type: 'accept-friend', publicKey }); }
  removeFriend(friendNumber: number): Promise<void> { return this.call({ type: 'remove-friend', friendNumber }); }
  sendMessage(friendNumber: number, text: string): Promise<number> { return this.call({ type: 'send-message', friendNumber, text }); }
  snapshot(): Promise<unknown> { return this.call({ type: 'snapshot' }); }

  private call<T = void>(command: ToxCommand): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('Tox client is stopped'));
    const requestId = ++this.requestId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, { resolve: (value) => resolve(value as T), reject });
      const request: ToxWorkerRequest = { requestId, command };
      this.worker.postMessage(request);
    });
  }

  private receive(response: ToxWorkerResponse): void {
    if (response.kind === 'event') { this.emit(response.event); return; }
    const operation = this.pending.get(response.requestId);
    if (!operation) return;
    this.pending.delete(response.requestId);
    if (response.ok) operation.resolve(response.result);
    else operation.reject(new Error(response.error));
  }

  private emit(event: ToxEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function validateNodes(value: unknown): asserts value is ToxBootstrapNode[] {
  if (!Array.isArray(value) || !value.every((node) => node && typeof node === 'object'
    && typeof (node as ToxBootstrapNode).host === 'string'
    && Number.isInteger((node as ToxBootstrapNode).port)
    && Array.isArray((node as ToxBootstrapNode).tcpPorts)
    && /^[0-9A-F]{64}$/i.test((node as ToxBootstrapNode).publicKey))) {
    throw new Error('Bundled Tox bootstrap list is invalid');
  }
}
