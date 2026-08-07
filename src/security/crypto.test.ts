import { describe, expect, it } from 'vitest';
import { decryptEnvelope, encryptEnvelope } from './crypto';

const TEST_KDF = { iterations: 1, memoryKiB: 64, parallelism: 1 };

describe('encrypted envelope', () => {
  it('round-trips without exposing plaintext', async () => {
    const secret = { credential: 'correct horse battery staple', message: 'private hello' };
    const envelope = await encryptEnvelope(secret, 'a strong local password', TEST_KDF);
    expect(JSON.stringify(envelope)).not.toContain(secret.credential);
    expect(JSON.stringify(envelope)).not.toContain(secret.message);
    await expect(decryptEnvelope(envelope, 'a strong local password')).resolves.toEqual(secret);
  });

  it('rejects a wrong password', async () => {
    const envelope = await encryptEnvelope({ ok: true }, 'the correct password', TEST_KDF);
    await expect(decryptEnvelope(envelope, 'the incorrect password')).rejects.toThrow(/incorrect|damaged/i);
  });

  it('rejects tampered ciphertext', async () => {
    const envelope = await encryptEnvelope({ ok: true }, 'the correct password', TEST_KDF);
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}AA`;
    await expect(decryptEnvelope(envelope, 'the correct password')).rejects.toThrow(/incorrect|damaged/i);
  });
});
