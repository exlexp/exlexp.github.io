import { describe, expect, it } from 'vitest';
import { bytesToBase64 } from '../../security/encoding';
import { createScramSession } from './scram';

describe('SCRAM mechanism compatibility', () => {
  it.each(['SHA-256', 'SHA-1'] as const)('creates a valid proof using %s', async (hash) => {
    const session = createScramSession('user', hash);
    const salt = bytesToBase64(new TextEncoder().encode('server-salt'));
    const result = await session.respond(`r=${session.clientNonce}server,s=${salt},i=4096`, 'correct horse battery staple');
    expect(result.response).toContain(`r=${session.clientNonce}server`);
    expect(result.response).toMatch(/,p=[A-Za-z0-9+/=]+$/);
    expect(result.serverSignature.length).toBeGreaterThan(20);
  });
});
