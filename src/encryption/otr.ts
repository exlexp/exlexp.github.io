import type { OtrAccountState } from '../models/types';

export type OtrEvent =
  | { type: 'wire'; peer: string; body: string; localId?: string }
  | { type: 'message'; peer: string; body: string; messageId?: string; timestamp?: number }
  | { type: 'state'; peer: string; state: 'negotiating' | 'encrypted' | 'ended'; fingerprint?: string }
  | { type: 'error'; peer?: string; message: string; severity: 'warn' | 'error' };

type WorkerEvent = OtrEvent | { type: 'ready'; privateKey: string; instanceTag: string; fingerprint: string };
type Listener = (event: OtrEvent) => void;

export class OtrManager {
  private readonly worker = new Worker(new URL('./otr.worker.ts', import.meta.url), { type: 'module', name: 'relayless-otr' });
  private readonly listeners = new Set<Listener>();
  private readonly encryptedPeers = new Set<string>();
  private readonly fingerprints = new Map<string, string>();
  private readyResolve!: () => void;
  private readyReject!: (reason: Error) => void;
  private readonly ready = new Promise<void>((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });

  private constructor(
    saved: OtrAccountState | undefined,
    private readonly persist: (state: OtrAccountState) => Promise<void>,
  ) {
    this.worker.addEventListener('message', (event: MessageEvent<WorkerEvent>) => void this.handle(event.data));
    this.worker.addEventListener('error', () => this.readyReject(new Error('OTR worker could not start')));
    this.worker.postMessage({ type: 'init', privateKey: saved?.privateKey, instanceTag: saved?.instanceTag });
  }

  static async open(saved: OtrAccountState | undefined, persist: (state: OtrAccountState) => Promise<void>): Promise<OtrManager> {
    const manager = new OtrManager(saved, persist);
    await manager.ready;
    return manager;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isEncrypted(peer: string): boolean { return this.encryptedPeers.has(peer); }
  fingerprintFor(peer: string): string { return this.fingerprints.get(normalizePeer(peer)) ?? ''; }

  async start(peer: string): Promise<void> {
    await this.ready;
    this.worker.postMessage({ type: 'start', peer: normalizePeer(peer) });
  }

  async send(peer: string, body: string, localId: string): Promise<void> {
    await this.ready;
    this.worker.postMessage({ type: 'send', peer: normalizePeer(peer), body, localId });
  }

  async receive(peer: string, body: string, messageId: string, timestamp: number): Promise<void> {
    await this.ready;
    this.worker.postMessage({ type: 'receive', peer: normalizePeer(peer), body, messageId, timestamp });
  }

  async end(peer: string): Promise<void> {
    await this.ready;
    this.encryptedPeers.delete(normalizePeer(peer));
    this.fingerprints.delete(normalizePeer(peer));
    this.worker.postMessage({ type: 'end', peer: normalizePeer(peer) });
  }

  reset(): void {
    this.encryptedPeers.clear();
    this.fingerprints.clear();
    this.worker.postMessage({ type: 'reset' });
  }

  close(): void {
    this.encryptedPeers.clear();
    this.fingerprints.clear();
    this.worker.terminate();
  }

  private async handle(event: WorkerEvent): Promise<void> {
    if (event.type === 'ready') {
      try {
        await this.persist({ version: 1, privateKey: event.privateKey, instanceTag: event.instanceTag, fingerprint: event.fingerprint });
        this.readyResolve();
      } catch (reason) {
        this.readyReject(reason instanceof Error ? reason : new Error('OTR identity could not be saved'));
      }
      return;
    }
    if (event.type === 'state') {
      if (event.state === 'encrypted') {
        this.encryptedPeers.add(event.peer);
        if (event.fingerprint) this.fingerprints.set(event.peer, event.fingerprint);
      }
      if (event.state === 'ended') {
        this.encryptedPeers.delete(event.peer);
        this.fingerprints.delete(event.peer);
      }
    }
    for (const listener of this.listeners) listener(event);
  }
}

function normalizePeer(peer: string): string {
  const normalized = peer.trim();
  if (!normalized.includes('@') || normalized.length > 3071) throw new Error('Invalid OTR peer JID');
  return normalized;
}
