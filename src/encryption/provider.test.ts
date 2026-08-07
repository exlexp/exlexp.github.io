import { describe, expect, it } from 'vitest';
import { resolveEncryptionProvider } from './provider';

describe('encryption policy', () => {
  it('prefers OMEMO and then OTR in secure-auto mode', () => {
    expect(resolveEncryptionProvider('secure-auto', { omemo: true, otr: true })).toBe('omemo');
    expect(resolveEncryptionProvider('secure-auto', { omemo: false, otr: true })).toBe('otr');
  });

  it('refuses every downgrade from secure-auto to plaintext', () => {
    expect(() => resolveEncryptionProvider('secure-auto', { omemo: false, otr: false })).toThrow(/not sent/i);
    expect(() => resolveEncryptionProvider('secure-auto', { omemo: false, otr: false }, true)).toThrow(/not sent/i);
  });

  it('refuses unavailable forced providers', () => {
    expect(() => resolveEncryptionProvider('force-omemo', { omemo: false, otr: true })).toThrow(/required but unavailable/i);
    expect(() => resolveEncryptionProvider('force-otr', { omemo: true, otr: false })).toThrow(/required but unavailable/i);
  });

  it('allows TLS-only XMPP only after an explicit chat choice', () => {
    expect(() => resolveEncryptionProvider('plaintext', { omemo: true, otr: false })).toThrow(/confirmation/i);
    expect(resolveEncryptionProvider('plaintext', { omemo: true, otr: false }, true)).toBe('plaintext');
  });
});
