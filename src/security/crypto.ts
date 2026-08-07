import { argon2id } from 'hash-wasm';
import { base64ToBytes, bytesToBase64, clearBytes, randomBytes, toArrayBuffer, utf8 } from './encoding';

const ENVELOPE_AAD = 'relayless:vault:1';
const MAX_CIPHERTEXT_BYTES = 64 * 1024 * 1024;
const MAX_KDF_ITERATIONS = 10;
const MAX_KDF_MEMORY_KIB = 256 * 1024;
const MAX_KDF_PARALLELISM = 4;

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

export interface EnvelopeCipher {
  readonly key: CryptoKey;
  readonly salt: string;
  readonly kdfParameters: KdfParameters;
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
  const cipher = await createEnvelopeCipher(password, parameters);
  return encryptEnvelopeWithCipher(value, cipher);
}

export async function createEnvelopeCipher(password: string, parameters: KdfParameters = DEFAULT_KDF): Promise<EnvelopeCipher> {
  validateKdfParameters(parameters);
  const saltBytes = randomBytes(16);
  const material = await deriveKeyMaterial(password, saltBytes, parameters);
  try {
    return { key: await importAesKey(material), salt: bytesToBase64(saltBytes), kdfParameters: { ...parameters } };
  } finally {
    clearBytes(material);
  }
}

export async function openEnvelopeCipher(envelope: EncryptedEnvelope, password: string): Promise<EnvelopeCipher> {
  validateEnvelope(envelope);
  const saltBytes = decodeSizedBase64(envelope.salt, 16, 16, 'salt');
  const material = await deriveKeyMaterial(password, saltBytes, envelope.kdfParameters);
  try {
    return { key: await importAesKey(material), salt: envelope.salt, kdfParameters: { ...envelope.kdfParameters } };
  } finally {
    clearBytes(material);
  }
}

export async function encryptEnvelopeWithCipher(value: unknown, cipher: EnvelopeCipher): Promise<EncryptedEnvelope> {
  const nonce = randomBytes(12);
  const plaintext = utf8(JSON.stringify(value));
  try {
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(nonce), additionalData: toArrayBuffer(utf8(ENVELOPE_AAD)), tagLength: 128 },
      cipher.key,
      toArrayBuffer(plaintext),
    );
    return {
      version: 1,
      algorithm: 'AES-256-GCM',
      kdf: 'Argon2id',
      kdfParameters: { ...cipher.kdfParameters },
      salt: cipher.salt,
      nonce: bytesToBase64(nonce),
      ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    };
  } finally {
    clearBytes(plaintext);
  }
}

export async function decryptEnvelope<T>(envelope: EncryptedEnvelope, password: string): Promise<T> {
  const cipher = await openEnvelopeCipher(envelope, password);
  return decryptEnvelopeWithCipher<T>(envelope, cipher);
}

export async function decryptEnvelopeWithCipher<T>(envelope: EncryptedEnvelope, cipher: EnvelopeCipher): Promise<T> {
  validateEnvelope(envelope);
  if (envelope.salt !== cipher.salt || JSON.stringify(envelope.kdfParameters) !== JSON.stringify(cipher.kdfParameters)) {
    throw new Error('Vault cipher does not match the encrypted envelope');
  }
  const nonce = decodeSizedBase64(envelope.nonce, 12, 12, 'nonce');
  const ciphertext = decodeSizedBase64(envelope.ciphertext, 16, MAX_CIPHERTEXT_BYTES, 'ciphertext');
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: toArrayBuffer(nonce),
        additionalData: toArrayBuffer(utf8(ENVELOPE_AAD)),
        tagLength: 128,
      },
      cipher.key,
      toArrayBuffer(ciphertext),
    );
    const bytes = new Uint8Array(plaintext);
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as T;
    } finally {
      clearBytes(bytes);
    }
  } catch {
    throw new Error('The password is incorrect or the vault is damaged');
  }
}

export function serializeEnvelope(envelope: EncryptedEnvelope): string {
  return JSON.stringify(envelope);
}

export function parseEnvelope(value: string): EncryptedEnvelope {
  if (new TextEncoder().encode(value).byteLength > MAX_CIPHERTEXT_BYTES * 2) throw new Error('Vault backup is too large');
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid vault backup');
  validateEnvelope(parsed as EncryptedEnvelope);
  return parsed as EncryptedEnvelope;
}

function validateEnvelope(envelope: EncryptedEnvelope): void {
  if (
    !envelope ||
    envelope.version !== 1 ||
    envelope.algorithm !== 'AES-256-GCM' ||
    envelope.kdf !== 'Argon2id'
  ) throw new Error('Unsupported encrypted vault format');
  validateKdfParameters(envelope.kdfParameters);
  if (typeof envelope.salt !== 'string' || typeof envelope.nonce !== 'string' || typeof envelope.ciphertext !== 'string') {
    throw new Error('Invalid vault backup');
  }
}

function validateKdfParameters(parameters: KdfParameters): void {
  if (
    !parameters ||
    !Number.isInteger(parameters.iterations) || parameters.iterations < 1 || parameters.iterations > MAX_KDF_ITERATIONS ||
    !Number.isInteger(parameters.memoryKiB) || parameters.memoryKiB < 64 || parameters.memoryKiB > MAX_KDF_MEMORY_KIB ||
    !Number.isInteger(parameters.parallelism) || parameters.parallelism < 1 || parameters.parallelism > MAX_KDF_PARALLELISM
  ) throw new Error('Unsafe vault key-derivation parameters');
}

function decodeSizedBase64(value: string, minimum: number, maximum: number, label: string): Uint8Array {
  let bytes: Uint8Array;
  try { bytes = base64ToBytes(value); } catch { throw new Error(`Invalid vault ${label}`); }
  if (bytes.byteLength < minimum || bytes.byteLength > maximum) throw new Error(`Invalid vault ${label}`);
  return bytes;
}
