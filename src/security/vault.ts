import { deleteDB, openDB, type IDBPDatabase } from 'idb';
import { migrateVaultData, serializableVault } from '../models/profiles';
import { createEmptyVault, type LocalProfile, type VaultData } from '../models/types';
import {
  decryptEnvelope,
  encryptEnvelope,
  parseEnvelope,
  serializeEnvelope,
  type EncryptedEnvelope,
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

  get isUnlocked(): boolean {
    return this.data !== undefined;
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
    await this.persist(kdf);
  }

  createEphemeral(language: 'ru' | 'en'): void {
    this.mode = 'ephemeral';
    this.data = createEmptyVault(language);
    this.password = undefined;
  }

  async unlock(password: string): Promise<void> {
    const db = await this.openDatabase();
    const envelope = (await db.get(STORE_NAME, RECORD_KEY)) as EncryptedEnvelope | undefined;
    if (!envelope) throw new Error('No persistent vault exists');
    this.data = migrateVaultData(await decryptEnvelope<unknown>(envelope, password));
    this.password = password;
    this.mode = 'persistent';
  }

  async update(mutator: (draft: VaultData) => void): Promise<void> {
    if (!this.data) throw new Error('Vault is locked');
    const next = structuredClone(this.data);
    mutator(next);
    this.data = next;
    if (this.mode === 'persistent') await this.persist();
  }

  lock(): void {
    this.data = undefined;
    this.password = undefined;
  }

  async changePassword(currentPassword: string, nextPassword: string): Promise<void> {
    if (!this.data || this.mode !== 'persistent') throw new Error('Persistent vault is not unlocked');
    const db = await this.openDatabase();
    const envelope = (await db.get(STORE_NAME, RECORD_KEY)) as EncryptedEnvelope;
    await decryptEnvelope(envelope, currentPassword);
    this.password = nextPassword;
    await this.persist();
  }

  async exportEncrypted(): Promise<string> {
    if (this.mode !== 'persistent') throw new Error('Ephemeral profiles cannot be exported');
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
    const data = migrateVaultData(await decryptEnvelope<unknown>(envelope, password));
    const db = await this.openDatabase();
    await db.put(STORE_NAME, envelope, RECORD_KEY);
    this.data = data;
    this.password = password;
    this.mode = 'persistent';
  }

  async wipe(): Promise<void> {
    this.lock();
    this.db?.close();
    this.db = undefined;
    await deleteDB(DB_NAME);
  }

  private async persist(kdf?: KdfParameters): Promise<void> {
    if (!this.data || !this.password) throw new Error('Persistent vault is not unlocked');
    const envelope = await encryptEnvelope(serializableVault(this.data), this.password, kdf);
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
