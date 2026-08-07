import { argon2id } from 'hash-wasm';
import { base64ToBytes, bytesToBase64, clearBytes, randomBytes, toArrayBuffer, utf8 } from './encoding';

const ENVELOPE_AAD = 'relayless:vault:1';

export interface KdfParameters {
  iterations: number;
  memoryKiB: number;
  parallelism: number;
}

export interface EncryptedEnvelope {
  version: 1;
  algorithm: 'AES-256-GCM';
  kdf: 'Argon2id';
  kdfParameters: KdfParameters;
  salt: string;
  nonce: string;
  ciphertext: string;
}

export const DEFAULT_KDF: KdfParameters = {
  iterations: 3,
  memoryKiB: 65_536,
  parallelism: 1,
};

async function deriveKeyMaterial(
  password: string,
  salt: Uint8Array,
  parameters: KdfParameters,
): Promise<Uint8Array> {
  if (password.length < 10) throw new Error('Vault password must contain at least 10 characters');
  return argon2id({
    password,
    salt,
    iterations: parameters.iterations,
    memorySize: parameters.memoryKiB,
    parallelism: parameters.parallelism,
    hashLength: 32,
    outputType: 'binary',
  });
}

async function importAesKey(material: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', toArrayBuffer(material), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptEnvelope(
  value: unknown,
  password: string,
  parameters: KdfParameters = DEFAULT_KDF,
): Promise<EncryptedEnvelope> {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const material = await deriveKeyMaterial(password, salt, parameters);
  try {
    const key = await importAesKey(material);
    const plaintext = utf8(JSON.stringify(value));
    try {
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: toArrayBuffer(nonce), additionalData: toArrayBuffer(utf8(ENVELOPE_AAD)), tagLength: 128 },
        key,
        toArrayBuffer(plaintext),
      );
      return {
        version: 1,
        algorithm: 'AES-256-GCM',
        kdf: 'Argon2id',
        kdfParameters: parameters,
        salt: bytesToBase64(salt),
        nonce: bytesToBase64(nonce),
        ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
      };
    } finally {
      clearBytes(plaintext);
    }
  } finally {
    clearBytes(material);
  }
}

export async function decryptEnvelope<T>(envelope: EncryptedEnvelope, password: string): Promise<T> {
  if (
    envelope.version !== 1 ||
    envelope.algorithm !== 'AES-256-GCM' ||
    envelope.kdf !== 'Argon2id'
  ) {
    throw new Error('Unsupported encrypted vault format');
  }
  const material = await deriveKeyMaterial(password, base64ToBytes(envelope.salt), envelope.kdfParameters);
  try {
    const key = await importAesKey(material);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: toArrayBuffer(base64ToBytes(envelope.nonce)),
        additionalData: toArrayBuffer(utf8(ENVELOPE_AAD)),
        tagLength: 128,
      },
      key,
      toArrayBuffer(base64ToBytes(envelope.ciphertext)),
    );
    const bytes = new Uint8Array(plaintext);
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as T;
    } finally {
      clearBytes(bytes);
    }
  } catch {
    throw new Error('The password is incorrect or the vault is damaged');
  } finally {
    clearBytes(material);
  }
}

export function serializeEnvelope(envelope: EncryptedEnvelope): string {
  return JSON.stringify(envelope);
}

export function parseEnvelope(value: string): EncryptedEnvelope {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid vault backup');
  return parsed as EncryptedEnvelope;
}
