interface LockRequester {
  request(
    name: string,
    options: { mode: 'exclusive'; ifAvailable: true },
    callback: (lock: object | null) => Promise<void>,
  ): Promise<void>;
}

/**
 * Keeps exactly one same-origin tab in charge of the encrypted vault and
 * protocol ratchets. The browser releases the underlying lock when the tab
 * is destroyed, including crashes and forced closes.
 */
export class SessionLease {
  private held = false;
  private acquiring: Promise<boolean> | undefined;

  constructor(private readonly locks: LockRequester | undefined = browserLocks()) {}

  acquire(): Promise<boolean> {
    if (this.held) return Promise.resolve(true);
    if (this.acquiring) return this.acquiring;
    if (!this.locks) {
      this.held = true;
      return Promise.resolve(true);
    }

    let settle!: (available: boolean) => void;
    const acquired = new Promise<boolean>((resolve) => { settle = resolve; });
    this.acquiring = acquired;
    let release!: () => void;
    const lifetime = new Promise<void>((resolve) => { release = resolve; });

    void this.locks.request('relayless-vault-session', { mode: 'exclusive', ifAvailable: true }, async (lock) => {
      if (!lock) {
        settle(false);
        return;
      }
      this.held = true;
      settle(true);
      await lifetime;
      this.held = false;
    }).catch(() => settle(false)).finally(() => {
      if (!this.held) this.acquiring = undefined;
    });

    // Kept reachable for the lifetime of the page. The lock manager releases
    // it automatically when this browsing context disappears.
    void release;
    return acquired;
  }
}

function browserLocks(): LockRequester | undefined {
  if (typeof navigator === 'undefined' || !navigator.locks) return undefined;
  return navigator.locks as unknown as LockRequester;
}
