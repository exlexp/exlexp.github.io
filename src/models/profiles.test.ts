import { describe, expect, it } from 'vitest';
import {
  activeProfile,
  aggregateUnread,
  createProfile,
  deleteProfile,
  duplicateProfileSettings,
  migrateVaultData,
  normalizeVault,
  reorderProfiles,
  serializableVault,
} from './profiles';
import { createEmptyVault } from './types';

describe('multi-profile model', () => {
  it('migrates a schema-v1 vault without losing namespaces', () => {
    const migrated = migrateVaultData({
      schemaVersion: 1,
      createdAt: 1,
      accounts: [{ id: 'a', protocol: 'xmpp', address: 'a@test', alias: 'A', presence: 'offline', enabled: true }],
      contacts: [], conversations: [], messages: [], linkedIdentities: [],
      settings: { language: 'en', theme: 'dark', autoLockMinutes: 15, retainHistory: true, showNotificationPreviews: false, debugEnabled: false },
    });
    expect(migrated.schemaVersion).toBe(2);
    expect(activeProfile(migrated).accounts[0]?.address).toBe('a@test');
  });

  it('removes exact local duplicates and cross-protocol copies during normalization', () => {
    const data = createEmptyVault('en');
    const profile = data.profiles[0]!;
    profile.accounts.push(
      { id: 'tox', protocol: 'tox', address: 'tox-id', alias: 'Tox', presence: 'offline', enabled: true },
      { id: 'xmpp', protocol: 'xmpp', address: 'me@example.org', alias: 'XMPP', presence: 'offline', enabled: true },
    );
    profile.contacts.push(
      { id: 'tc', accountId: 'tox', protocol: 'tox', address: 'A'.repeat(64), alias: 'Tox friend', presence: 'offline' },
      { id: 'xc', accountId: 'xmpp', protocol: 'xmpp', address: 'friend@example.org', alias: 'XMPP friend', presence: 'offline' },
    );
    profile.conversations.push(
      { id: 'tox-chat', contactId: 'tc', protocol: 'tox', title: 'Tox friend', unread: 0, updatedAt: 1 },
      { id: 'xmpp-chat', contactId: 'xc', protocol: 'xmpp', title: 'XMPP friend', unread: 0, updatedAt: 1 },
    );
    const message = { id: 'a', conversationId: 'tox-chat', direction: 'outgoing' as const, body: 'hello', timestamp: 10, delivery: 'sent' as const, sourceAccountId: 'tox' };
    profile.messages.push(message, { ...message, id: 'b' }, { ...message, id: 'c', conversationId: 'xmpp-chat' });
    normalizeVault(data);
    expect(profile.messages).toEqual([message]);
  });

  it('keeps messages, drafts, keys, and contacts isolated', () => {
    const data = createEmptyVault('en');
    const secondId = createProfile(data, 'Work');
    const first = data.profiles[0]!; const second = data.profiles.find((profile) => profile.id === secondId)!;
    first.messages.push({ id: 'm', conversationId: 'c', direction: 'incoming', body: 'first only', timestamp: 1, delivery: 'delivered' });
    first.accounts.push({ id: 'tox-a', protocol: 'tox', address: 'id', alias: 'tox', savedata: 'private-key-a', presence: 'offline', enabled: true });
    first.drafts.c = 'draft-a';
    expect(second.messages).toEqual([]); expect(second.accounts).toEqual([]); expect(second.drafts).toEqual({});
  });

  it('duplicates only profile settings and supports reorder/delete', () => {
    const data = createEmptyVault('en');
    const source = data.profiles[0]!; source.settings.statusMessage = 'Available';
    source.accounts.push({ id: 'secret', protocol: 'xmpp', address: 'a@test', alias: 'A', secret: 'pw', presence: 'offline', enabled: true });
    const duplicateId = duplicateProfileSettings(data, source.id, 'Copy');
    const duplicate = data.profiles.find((profile) => profile.id === duplicateId)!;
    expect(duplicate.settings.statusMessage).toBe('Available'); expect(duplicate.accounts).toEqual([]);
    reorderProfiles(data, duplicateId, source.id); expect(data.profiles[0]?.id).toBe(duplicateId);
    deleteProfile(data, duplicateId); expect(data.profiles).toHaveLength(1);
  });

  it('excludes ephemeral profiles from serialized data', () => {
    const data = createEmptyVault('en');
    const id = createProfile(data, 'Temporary', true); data.activeProfileId = id;
    const serialized = serializableVault(data);
    expect(serialized.profiles.some((profile) => profile.id === id)).toBe(false);
    expect(serialized.activeProfileId).not.toBe(id);
  });

  it('keeps chats and contacts when local message history is disabled', () => {
    const data = createEmptyVault('en');
    const profile = data.profiles[0]!;
    data.settings.retainHistory = false;
    profile.contacts.push({ id: 'contact', accountId: 'account', protocol: 'tox', address: 'A'.repeat(64), alias: 'Friend', presence: 'offline', remoteId: '2' });
    profile.conversations.push({ id: 'chat', contactId: 'contact', protocol: 'tox', title: 'Friend', unread: 0, updatedAt: 1 });
    profile.messages.push({ id: 'message', conversationId: 'chat', direction: 'outgoing', body: 'private', timestamp: 1, delivery: 'sent' });
    const serialized = serializableVault(data);
    expect(serialized.profiles[0]?.contacts).toHaveLength(1);
    expect(serialized.profiles[0]?.conversations).toHaveLength(1);
    expect(serialized.profiles[0]?.messages).toEqual([]);
  });

  it('aggregates unread messages per profile', () => {
    const profile = createEmptyVault('en').profiles[0]!;
    profile.conversations.push(
      { id: '1', contactId: 'a', protocol: 'xmpp', title: 'A', unread: 2, updatedAt: 1 },
      { id: '2', contactId: 'b', protocol: 'tox', title: 'B', unread: 3, updatedAt: 1 },
    );
    expect(aggregateUnread(profile)).toBe(5);
  });
});
