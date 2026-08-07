export type ConnectionKind =
  | 'xmpp-provider'
  | 'tox-bootstrap'
  | 'tox-relay'
  | 'tox-peer'
  | 'application-update'
  | 'external-documentation';

export type ConnectionState = 'opening' | 'open' | 'retrying' | 'closed' | 'failed';

export interface NetworkActivity {
  id: string;
  protocol: 'XMPP' | 'TOX' | 'HTTPS';
  destination: string;
  port: number;
  kind: ConnectionKind;
  startedAt: number;
  state: ConnectionState;
  source: 'user' | 'bundled-public-node' | 'distribution';
}

type Listener = (connections: NetworkActivity[]) => void;

export class NetworkPolicy {
  private readonly activities = new Map<string, NetworkActivity>();
  private readonly listeners = new Set<Listener>();

  open(activity: Omit<NetworkActivity, 'id' | 'startedAt' | 'state'>): string {
    this.assertAllowed(activity);
    const id = crypto.randomUUID();
    this.activities.set(id, { ...activity, id, startedAt: Date.now(), state: 'opening' });
    this.emit();
    return id;
  }

  setState(id: string, state: ConnectionState): void {
    const current = this.activities.get(id);
    if (!current) return;
    this.activities.set(id, { ...current, state });
    this.emit();
  }

  snapshot(): NetworkActivity[] {
    return [...this.activities.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  clearClosed(): void {
    for (const [id, activity] of this.activities) {
      if (activity.state === 'closed' || activity.state === 'failed') this.activities.delete(id);
    }
    this.emit();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  private assertAllowed(activity: Omit<NetworkActivity, 'id' | 'startedAt' | 'state'>): void {
    if (!activity.destination.trim()) throw new Error('Network destination is required');
    if (!Number.isInteger(activity.port) || activity.port < 1 || activity.port > 65_535) {
      throw new Error('Network port is outside the valid range');
    }
    if (activity.kind === 'xmpp-provider' && activity.source !== 'user') {
      throw new Error('XMPP providers must be selected by the user');
    }
  }

  private emit(): void {
    const value = this.snapshot();
    for (const listener of this.listeners) listener(value);
  }
}

export const networkPolicy = new NetworkPolicy();
