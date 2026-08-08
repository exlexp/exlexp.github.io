import { afterEach, describe, expect, it } from 'vitest';
import { openDB } from 'idb';
import { Vault } from './vault';
import { encryptEnvelope, serializeEnvelope } from './crypto';

describe('vault persistence', () => {
  const vault = new Vault();
  afterEach(async () => { await vault.wipe(); });

  it('stores only an encrypted envelope and unlocks it', async () => {
    await vault.create('a sufficiently long password', 'en', { iterations: 1, memoryKiB: 64, parallelism: 1 });
    const initialEnvelope = JSON.parse(await vault.exportEncrypted()) as { salt: string; nonce: string };
    await vault.update((draft) => { draft.profiles[0]!.accounts.push({ id: '1', protocol: 'xmpp', address: 'alice@example.test', alias: 'Alice', secret: 'test-secret', presence: 'offline', enabled: true }); });
    const backup = await vault.exportEncrypted();
    const updatedEnvelope = JSON.parse(backup) as { salt: string; nonce: string };
    expect(backup).not.toContain('alice@example.test');
    expect(backup).not.toContain('test-secret');
    expect(updatedEnvelope.salt).toBe(initialEnvelope.salt);
    expect(updatedEnvelope.nonce).not.toBe(initialEnvelope.nonce);
    vault.lock();
    await vault.unlock('a sufficiently long password');
    expect(vault.snapshot.profiles[0]?.accounts[0]?.alias).toBe('Alice');
  });

  it('unlocks after a refresh with a non-exportable device key', async () => {
    const password = 'a sufficiently long password';
    await vault.create(password, 'en', { iterations: 1, memoryKiB: 64, parallelism: 1 });
    await vault.update((draft) => { draft.profiles[0]!.name = 'Remembered locally'; });
    await vault.enableDeviceUnlock();
    vault.lock();

    const refreshedVault = new Vault();
    expect(await refreshedVault.tryDeviceUnlock()).toBe(true);
    expect(refreshedVault.snapshot.profiles[0]?.name).toBe('Remembered locally');
    refreshedVault.lock();
  });

  it('does not keep a reusable password in the device-unlock record', async () => {
    await vault.create('a sufficiently long password', 'en', { iterations: 1, memoryKiB: 64, parallelism: 1 });
    await vault.enableDeviceUnlock();
    const db = await openDB('relayless-local-vault');
    const record = await db.get('encrypted', 'wrapped-password') as Record<string, unknown>;
    const key = await db.get('encrypted', 'key') as CryptoKey;
    db.close();
    expect(record).toEqual({ version: 2 });
    expect(key.extractable).toBe(false);
    expect(key.usages).toEqual(expect.arrayContaining(['encrypt', 'decrypt']));
  });

  it('forgets device unlock when explicitly disabled', async () => {
    const password = 'a sufficiently long password';
    await vault.create(password, 'en', { iterations: 1, memoryKiB: 64, parallelism: 1 });
    await vault.enableDeviceUnlock();
    await vault.disableDeviceUnlock();
    vault.lock();

    const refreshedVault = new Vault();
    expect(await refreshedVault.tryDeviceUnlock()).toBe(false);
  });

  it('keeps ephemeral data out of IndexedDB', async () => {
    vault.createEphemeral('ru');
    await vault.update((draft) => { draft.profiles[0]!.messages.push({ id: 'm', conversationId: 'c', direction: 'incoming', body: 'memory only', timestamp: 1, delivery: 'delivered' }); });
    expect(await vault.exists()).toBe(false);
    expect(vault.snapshot.profiles[0]?.messages).toHaveLength(1);
  });

  it('keeps messages available for the session but never persists them when history is disabled', async () => {
    await vault.create('a sufficiently long password', 'en', { iterations: 1, memoryKiB: 64, parallelism: 1 });
    await vault.update((draft) => {
      draft.settings.retainHistory = false;
      draft.profiles[0]!.messages.push({ id: 'm', conversationId: 'c', direction: 'incoming', body: 'session only', timestamp: 1, delivery: 'delivered' });
      draft.profiles[0]!.drafts.c = 'private draft';
    });
    expect(vault.snapshot.profiles[0]!.messages).toHaveLength(1);
    vault.lock();
    await vault.unlock('a sufficiently long password');
    expect(vault.snapshot.profiles[0]!.messages).toHaveLength(0);
    expect(vault.snapshot.profiles[0]!.drafts).toEqual({});
  });

  it('serializes simultaneous updates without losing data', async () => {
    vault.createEphemeral('en');
    await Promise.all(Array.from({ length: 20 }, (_, index) => vault.update((draft) => {
      draft.profiles[0]!.drafts[`conversation-${index}`] = `message-${index}`;
    })));
    expect(Object.keys(vault.snapshot.profiles[0]!.drafts)).toHaveLength(20);
  });

  it('exports and imports one encrypted isolated profile', async () => {
    await vault.create('a sufficiently long password', 'en', { iterations: 1, memoryKiB: 64, parallelism: 1 });
    const originalId = vault.snapshot.profiles[0]!.id;
    await vault.update((draft) => { draft.profiles[0]!.accounts.push({ id: 'a', protocol: 'xmpp', address: 'private@example.test', alias: 'Private', secret: 'profile-secret', presence: 'offline', enabled: true }); });
    const backup = await vault.exportProfile(originalId);
    expect(backup).not.toContain('private@example.test'); expect(backup).not.toContain('profile-secret');
    const importedId = await vault.importProfile(backup);
    expect(importedId).not.toBe(originalId);
    expect(vault.snapshot.profiles.find((profile) => profile.id === importedId)?.accounts[0]?.secret).toBe('profile-secret');
  });

  it('imports legacy profile backups with their original password', async () => {
    await vault.create('a sufficiently long password', 'en', { iterations: 1, memoryKiB: 64, parallelism: 1 });
    const profile = vault.snapshot.profiles[0]!;
    profile.name = 'Legacy profile';
    const backup = serializeEnvelope(await encryptEnvelope(
      { kind: 'relayless-profile', version: 1, profile },
      'legacy backup password',
      { iterations: 1, memoryKiB: 64, parallelism: 1 },
    ));
    await expect(vault.importProfile(backup)).rejects.toThrow(/different vault key/i);
    const importedId = await vault.importProfile(backup, 'legacy backup password');
    expect(vault.snapshot.profiles.find((item) => item.id === importedId)?.name).toContain('Legacy profile');
  });

  it('exports one account and its related history without plaintext leakage', async () => {
    await vault.create('a sufficiently long password', 'en', { iterations: 1, memoryKiB: 64, parallelism: 1 });
    const profileId = vault.snapshot.profiles[0]!.id;
    await vault.update((draft) => {
      const profile = draft.profiles[0]!;
      profile.accounts.push({ id: 'tox-account', protocol: 'tox', address: 'TOX-ID', alias: 'Private Tox', savedata: 'private-savedata', presence: 'offline', enabled: true });
      profile.contacts.push({ id: 'contact', accountId: 'tox-account', protocol: 'tox', address: 'FRIEND', alias: 'Friend', presence: 'offline' });
      profile.conversations.push({ id: 'conversation', contactId: 'contact', protocol: 'tox', title: 'Friend', unread: 0, updatedAt: 1 });
      profile.messages.push({ id: 'message', conversationId: 'conversation', direction: 'incoming', body: 'private message', timestamp: 1, delivery: 'delivered' });
    });
    const backup = await vault.exportAccount(profileId, 'tox-account');
    expect(backup).not.toContain('private-savedata');
    expect(backup).not.toContain('private message');
    expect(backup).not.toContain('Friend');
  });

  it('requires an explicit encryption password for ephemeral account exports', async () => {
    vault.createEphemeral('en');
    const profile = vault.snapshot.profiles[0]!;
    await vault.update((draft) => { draft.profiles[0]!.accounts.push({ id: 'account', protocol: 'tox', address: 'TOX-ID', alias: 'Tox', savedata: 'secret', presence: 'offline', enabled: true }); });
    await expect(vault.exportAccount(profile.id, 'account')).rejects.toThrow(/password/i);
    await expect(vault.exportAccount(profile.id, 'account', 'backup password')).resolves.toContain('ciphertext');
  });
});
