import { describe, expect, it } from 'vitest';
import { createEmptyVault } from './types';
import { reconcileToxFriends, resolveToxContact } from './toxIdentity';

describe('Tox stable contact identity', () => {
  it('does not attach a reused friend number to the previous public key', () => {
    const profile = createEmptyVault('en').profiles[0]!;
    profile.contacts.push({ id: 'old', accountId: 'tox', protocol: 'tox', address: 'A'.repeat(64), alias: 'Old', presence: 'online', remoteId: '0' });
    reconcileToxFriends(profile, 'tox', [{ friendNumber: 0, publicKey: 'B'.repeat(64) }]);
    expect(profile.contacts.find((item) => item.id === 'old')?.remoteId).toBeUndefined();
    expect(profile.contacts.find((item) => item.address === 'B'.repeat(64))).toMatchObject({ remoteId: '0' });
  });

  it('resolves events by public key before mutable friend number', () => {
    const profile = createEmptyVault('en').profiles[0]!;
    profile.contacts.push({ id: 'known', accountId: 'tox', protocol: 'tox', address: 'C'.repeat(64), alias: 'Known', presence: 'offline' });
    expect(resolveToxContact(profile, 'tox', 7, 'c'.repeat(64), false)?.id).toBe('known');
    expect(profile.contacts[0]?.remoteId).toBe('7');
  });
});
