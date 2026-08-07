import { describe, expect, it } from 'vitest';
import { redactObject, redactText } from './redaction';

describe('diagnostic redaction', () => {
  it('redacts JIDs, Tox IDs, and sensitive object keys', () => {
    const toxId = 'A'.repeat(76);
    expect(redactText(`alice@example.test ${toxId}`)).toBe('[jid] [tox-id]');
    expect(redactObject({ password: 'secret', nested: { token: 'value', status: 'ok' } })).toEqual({ password: '[redacted]', nested: { token: '[redacted]', status: 'ok' } });
  });
});
