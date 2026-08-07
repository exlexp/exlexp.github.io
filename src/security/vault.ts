import { deleteDB, openDB, type IDBPDatabase } from 'idb';
import { migrateVaultData, serializableVault } from '../models/profiles';
import { createEmptyVault, type LocalProfile, type VaultData } from '../models/types';
import {
  decryptEnvelope,
  decryptEnvelopeWithCipher,
  createEnvelopeCipher,
  encryptEnvelope,
  encryptEnvelopeWithCipher,
  openEnvelopeCipher,
  parseEnvelope,
  serializeEnvelope,
  type EncryptedEnvelope,
  type EnvelopeCipher,
  type KdfParameters,
} from './crypto';

const DB_NAME = 'relayless-local-vault';
const STORE_NAME = 'encrypted';
const RECORD_KEY = 'vault';

type Mode = 'persistent' | 'ephemeral';

export class Vault {
  private data: VaultData | undefined;
  private password: string | undefined;
  private db: IDBPDatabase | undefined;
  private mode: Mode = 'persistent';
  private mutationQueue: Promise<void> = Promise.resolve();
  private cipher: EnvelopeCipher | undefined;

  get isUnlocked(): boolean {
    return this.data !== undefined;
  }

  get isPersistent(): boolean {
    return this.mode === 'persistent';
  }

  get snapshot(): VaultData {
    if (!this.data) throw new Error('Vault is locked');
    return structuredClone(this.data);
  }

  async exists(): Promise<boolean> {
    const db = await this.openDatabase();
    return (await db.get(STORE_NAME, RECORD_KEY)) !== undefined;
  }

  async create(password: string, language: 'ru' | 'en', kdf?: KdfParameters): Promise<void> {
    this.mode = 'persistent';
    this.data = createEmptyVault(language);
    this.password = password;
    this.cipher = await createEnvelopeCipher(password, kdf);
    await this.persist();
  }

  createEphemeral(language: 'ru' | 'en'): void {
    this.mode = 'ephemeral';
    this.data = createEmptyVault(language);
    this.password = undefined;
    this.cipher = undefined;
  }

  async unlock(password: string): Promise<void> {
    const db = await this.openDatabase();
    const envelope = (await db.get(STORE_NAME, RECORD_KEY)) as EncryptedEnvelope | undefined;
    if (!envelope) throw new Error('No persistent vault exists');
    const cipher = await openEnvelopeCipher(envelope, password);
    this.data = migrateVaultData(await decryptEnvelopeWithCipher<unknown>(envelope, cipher));
    this.password = password;
    this.cipher = cipher;
    this.mode = 'persistent';
  }

  async update(mutator: (draft: VaultData) => void): Promise<void> {
    const operation = this.mutationQueue.then(async () => {
      if (!this.data) throw new Error('Vault is locked');
      const next = structuredClone(this.data);
      mutator(next);
      this.data = next;
      if (this.mode === 'persistent') await this.persist();
    });
    this.mutationQueue = operation.catch(() => undefined);
    return operation;
  }

  lock(): void {
    this.data = undefined;
    this.password = undefined;
    this.cipher = undefined;
  }

  async changePassword(currentPassword: string, nextPassword: string): Promise<void> {
    if (!this.data || this.mode !== 'persistent') throw new Error('Persistent vault is not unlocked');
    const db = await this.openDatabase();
    const envelope = (await db.get(STORE_NAME, RECORD_KEY)) as EncryptedEnvelope;
    await decryptEnvelope(envelope, currentPassword);
    const cipher = await createEnvelopeCipher(nextPassword);
    this.password = nextPassword;
    this.cipher = cipher;
    await this.persist();
  }

  async exportEncrypted(): Promise<string> {
    if (this.mode !== 'persistent') throw new Error('Ephemeral profiles cannot be exported');
    await this.mutationQueue;
    const db = await this.openDatabase();
    const envelope = (await db.get(STORE_NAME, RECORD_KEY)) as EncryptedEnvelope | undefined;
    if (!envelope) throw new Error('No persistent vault exists');
    return serializeEnvelope(envelope);
  }

  async exportProfile(profileId: string): Promise<string> {
    if (!this.data || !this.password || this.mode !== 'persistent') {
      throw new Error('A persistent vault must be unlocked to export a profile');
    }
    const profile = this.data.profiles.find((item) => item.id === profileId);
    if (!profile) throw new Error('Profile does not exist');
    if (profile.ephemeral) throw new Error('Ephemeral profiles cannot be exported');
    return serializeEnvelope(await encryptEnvelope({ kind: 'relayless-profile', version: 1, profile }, this.password));
  }

  async exportAccount(profileId: string, accountId: string, exportPassword?: string): Promise<string> {
    if (!this.data) throw new Error('The vault must be unlocked to export an account');
    const password = this.mode === 'persistent' ? this.password : exportPassword;
    if (!password) throw new Error('A backup password is required for an ephemeral account');
    await this.mutationQueue;
    const profile = this.data.profiles.find((item) => item.id === profileId);
    const account = profile?.accounts.find((item) => item.id === accountId);
    if (!profile || !account) throw new Error('Account does not exist');
    const contacts = profile.contacts.filter((item) => item.accountId === accountId);
    const contactIds = new Set(contacts.map((item) => item.id));
    const conversations = profile.conversations.filter((item) => contactIds.has(item.contactId));
    const conversationIds = new Set(conversations.map((item) => item.id));
    const messages = profile.messages.filter((item) => conversationIds.has(item.conversationId));
    const drafts = Object.fromEntries(Object.entries(profile.drafts).filter(([id]) => conversationIds.has(id)));
    const payload = {
      kind: 'relayless-account',
      version: 1,
      exportedAt: Date.now(),
      account,
      contacts,
      friendRequests: profile.friendRequests.filter((item) => item.accountId === accountId),
      conversations,
      messages,
      drafts,
    };
    return serializeEnvelope(await encryptEnvelope(payload, password));
  }

  async importProfile(serialized: string): Promise<string> {
    if (!this.data || !this.password || this.mode !== 'persistent') {
      throw new Error('A persistent vault must be unlocked to import a profile');
    }
    const payload = await decryptEnvelope<{ kind: string; version: number; profile: LocalProfile }>(
      parseEnvelope(serialized),
      this.password,
    );
    if (payload.kind !== 'relayless-profile' || payload.version !== 1 || !payload.profile?.id) {
      throw new Error('Invalid encrypted profile backup');
    }
    const profile = structuredClone(payload.profile);
    profile.id = crypto.randomUUID();
    profile.name = `${profile.name} (imported)`;
    profile.order = this.data.profiles.length;
    profile.ephemeral = false;
    profile.locked = false;
    profile.runtimeState = 'disconnected';
    this.data.profiles.push(profile);
    await this.persist();
    return profile.id;
  }

  async importEncrypted(serialized: string, password: string): Promise<void> {
    const envelope = parseEnvelope(serialized);
    const cipher = await openEnvelopeCipher(envelope, password);
    const data = migrateVaultData(await decryptEnvelopeWithCipher<unknown>(envelope, cipher));
    const db = await this.openDatabase();
    await db.put(STORE_NAME, envelope, RECORD_KEY);
    this.data = data;
    this.password = password;
    this.cipher = cipher;
    this.mode = 'persistent';
  }

  async wipe(): Promise<void> {
    await this.mutationQueue.catch(() => undefined);
    this.lock();
    this.db?.close();
    this.db = undefined;
    await deleteDB(DB_NAME);
  }

  private async persist(): Promise<void> {
    if (!this.data || !this.password || !this.cipher) throw new Error('Persistent vault is not unlocked');
    const envelope = await encryptEnvelopeWithCipher(serializableVault(this.data), this.cipher);
    const db = await this.openDatabase();
    await db.put(STORE_NAME, envelope, RECORD_KEY);
  }

  private async openDatabase(): Promise<IDBPDatabase> {
    if (!this.db) {
      this.db = await openDB(DB_NAME, 1, {
        upgrade(database) {
          if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
        },
      });
    }
    return this.db;
  }
}
