import { deleteDB, wrap, type IDBPDatabase } from 'idb';
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
import { base64ToBytes, bytesToBase64, clearBytes, decodeUtf8, randomBytes, toArrayBuffer, utf8 } from './encoding';

const DB_NAME = 'relayless-local-vault';
const STORE_NAME = 'encrypted';
const RECORD_KEY = 'vault';
const DEVICE_KEY_RECORD = 'key';
const DEVICE_UNLOCK_RECORD = 'wrapped-password';
const DEVICE_UNLOCK_AAD = utf8('relayless:device-unlock:1');

interface WrappedDeviceUnlock {
  version: 1;
  nonce: string;
  ciphertext: string;
}

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

  async enableDeviceUnlock(password: string): Promise<void> {
    if (!this.data || this.mode !== 'persistent') throw new Error('Persistent vault is not unlocked');
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const nonce = randomBytes(12);
    const plaintext = utf8(password);
    try {
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: toArrayBuffer(nonce), additionalData: toArrayBuffer(DEVICE_UNLOCK_AAD), tagLength: 128 },
        key,
        toArrayBuffer(plaintext),
      );
      const record: WrappedDeviceUnlock = { version: 1, nonce: bytesToBase64(nonce), ciphertext: bytesToBase64(new Uint8Array(ciphertext)) };
      const db = await this.openDatabase();
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      await transaction.store.put(key, DEVICE_KEY_RECORD);
      await transaction.store.put(record, DEVICE_UNLOCK_RECORD);
      await transaction.done;
    } finally {
      clearBytes(nonce);
      clearBytes(plaintext);
    }
  }

  async tryDeviceUnlock(): Promise<boolean> {
    const db = await this.openDatabase();
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const key = await transaction.store.get(DEVICE_KEY_RECORD) as CryptoKey | undefined;
    const record = await transaction.store.get(DEVICE_UNLOCK_RECORD) as WrappedDeviceUnlock | undefined;
    await transaction.done;
    if (!key || !record) return false;

    let nonce: Uint8Array | undefined;
    let plaintext: Uint8Array | undefined;
    try {
      if (key.extractable || key.algorithm.name !== 'AES-GCM' || !key.usages.includes('decrypt')) throw new Error('Invalid device key');
      if (record.version !== 1 || record.nonce.length > 64 || record.ciphertext.length > 4096) throw new Error('Invalid device unlock record');
      nonce = base64ToBytes(record.nonce);
      if (nonce.byteLength !== 12) throw new Error('Invalid device unlock nonce');
      plaintext = new Uint8Array(await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: toArrayBuffer(nonce), additionalData: toArrayBuffer(DEVICE_UNLOCK_AAD), tagLength: 128 },
        key,
        toArrayBuffer(base64ToBytes(record.ciphertext)),
      ));
      await this.unlock(decodeUtf8(toArrayBuffer(plaintext)));
      return true;
    } catch {
      await this.disableDeviceUnlock();
      return false;
    } finally {
      if (nonce) clearBytes(nonce);
      if (plaintext) clearBytes(plaintext);
    }
  }

  async disableDeviceUnlock(): Promise<void> {
    const db = await this.openDatabase();
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    await transaction.store.delete(DEVICE_KEY_RECORD);
    await transaction.store.delete(DEVICE_UNLOCK_RECORD);
    await transaction.done;
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
    this.db?.close();
    this.db = undefined;
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
    await this.disableDeviceUnlock();
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
    await this.disableDeviceUnlock();
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
      const database = await new Promise<IDBPDatabase>((resolve, reject) => {
        const request = indexedDB.open(DB_NAME);
        let settled = false;
        const timeout = globalThis.setTimeout(() => {
          settled = true;
          reject(new Error('Local vault did not become available'));
        }, 8_000);
        request.addEventListener('upgradeneeded', () => {
          if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
        });
        request.addEventListener('success', () => {
          if (settled) { request.result.close(); return; }
          settled = true;
          globalThis.clearTimeout(timeout);
          resolve(wrap(request.result));
        });
        request.addEventListener('error', () => {
          if (settled) return;
          settled = true;
          globalThis.clearTimeout(timeout);
          reject(request.error ?? new Error('Local vault could not be opened'));
        });
        request.addEventListener('blocked', () => {
          if (settled) return;
          settled = true;
          globalThis.clearTimeout(timeout);
          reject(new Error('Another tab is updating the local vault'));
        });
      });
      this.db = database;
      database.addEventListener('versionchange', () => {
        database.close();
        if (this.db === database) this.db = undefined;
      });
    }
    return this.db;
  }
}
