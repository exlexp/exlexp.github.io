import { afterEach, describe, expect, it } from 'vitest';
import { Vault } from './vault';

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

  it('keeps ephemeral data out of IndexedDB', async () => {
    vault.createEphemeral('ru');
    await vault.update((draft) => { draft.profiles[0]!.messages.push({ id: 'm', conversationId: 'c', direction: 'incoming', body: 'memory only', timestamp: 1, delivery: 'delivered' }); });
    expect(await vault.exists()).toBe(false);
    expect(vault.snapshot.profiles[0]?.messages).toHaveLength(1);
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
});
