import { describe, expect, it } from 'vitest';
import { SessionLease } from './sessionLease';

describe('SessionLease', () => {
  it('holds an exclusive same-origin lock for the page lifetime', async () => {
    let requestedName = '';
    let requestedOptions: unknown;
    const locks = {
      async request(name: string, options: unknown, callback: (lock: object) => Promise<void>) {
        requestedName = name;
        requestedOptions = options;
        await callback({});
      },
    };
    const lease = new SessionLease(locks);
    await expect(lease.acquire()).resolves.toBe(true);
    await expect(lease.acquire()).resolves.toBe(true);
    expect(requestedName).toBe('relayless-vault-session');
    expect(requestedOptions).toEqual({ mode: 'exclusive', ifAvailable: true });
  });

  it('reports another active tab without waiting for it', async () => {
    const locks = { async request(_name: string, _options: unknown, callback: (lock: null) => Promise<void>) { await callback(null); } };
    const lease = new SessionLease(locks);
    await expect(lease.acquire()).resolves.toBe(false);
  });
});
