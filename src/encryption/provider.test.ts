import { describe, expect, it } from 'vitest';
import { PlaintextConfirmationRequired, resolveEncryptionProvider } from './provider';

describe('encryption policy', () => {
  it('prefers OMEMO and then OTR in secure-auto mode', () => {
    expect(resolveEncryptionProvider('secure-auto', { omemo: true, otr: true })).toBe('omemo');
    expect(resolveEncryptionProvider('secure-auto', { omemo: false, otr: true })).toBe('otr');
  });

  it('refuses silent downgrade to plaintext', () => {
    expect(() => resolveEncryptionProvider('secure-auto', { omemo: false, otr: false })).toThrow(PlaintextConfirmationRequired);
    expect(resolveEncryptionProvider('secure-auto', { omemo: false, otr: false }, true)).toBe('plaintext');
  });

  it('refuses unavailable forced providers', () => {
    expect(() => resolveEncryptionProvider('force-omemo', { omemo: false, otr: true })).toThrow(/required but unavailable/i);
    expect(() => resolveEncryptionProvider('force-otr', { omemo: true, otr: false })).toThrow(/required but unavailable/i);
  });
});
