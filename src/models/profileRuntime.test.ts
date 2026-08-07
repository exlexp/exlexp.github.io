import { describe, expect, it } from 'vitest';
import { createProfile } from './profiles';
import { requireSourceIdentity, switchProfileState } from './profileRuntime';
import { createEmptyVault } from './types';

describe('profile runtime isolation', () => {
  it.each([
    ['background', 'background', 0],
    ['sleep', 'sleeping', 1],
    ['disconnect', 'disconnected', 1],
  ] as const)('applies %s policy during rapid switching', (policy, expectedState, expectedStops) => {
    const data = createEmptyVault('en'); const first = data.profiles[0]!;
    first.settings.connectionPolicy = policy;
    first.accounts.push({ id: 'a', protocol: 'xmpp', address: 'a@test', alias: 'A', presence: 'online', enabled: true });
    const secondId = createProfile(data, 'Work');
    const result = switchProfileState(data, secondId, 10);
    expect(first.runtimeState).toBe(expectedState); expect(result.stopAccountIds).toHaveLength(expectedStops);
    expect(data.activeProfileId).toBe(secondId);
  });

  it('refuses previous-profile and ambiguous-source sending', () => {
    const data = createEmptyVault('en'); const first = data.profiles[0]!;
    first.accounts.push({ id: 'a', protocol: 'xmpp', address: 'a@test', alias: 'A', presence: 'online', enabled: true });
    const conversation = { id: 'c', contactId: 'x', protocol: 'xmpp' as const, title: 'X', unread: 0, updatedAt: 1 };
    const secondId = createProfile(data, 'Work'); switchProfileState(data, secondId);
    expect(() => requireSourceIdentity(data, first.id, conversation, 'a')).toThrow(/inactive profile/i);
    expect(() => requireSourceIdentity(data, secondId, conversation, 'a')).toThrow(/explicit compatible source/i);
  });
});
