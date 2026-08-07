import { describe, expect, it } from 'vitest';
import { OTR } from 'otr';
import { userA, userB } from 'otr/test/spec/unit/data/keys.js';

describe('legacy OTR interoperability', () => {
  it.each([
    ['v2', true, false],
    ['v3', false, true],
  ] as const)('negotiates %s and exchanges encrypted UTF-8 text', async (_name, allowV2, allowV3) => {
    const alice = new OTR({ priv: userA, instance_tag: OTR.makeInstanceTag(), send_interval: 0 });
    const bob = new OTR({ priv: userB, instance_tag: OTR.makeInstanceTag(), send_interval: 0 });
    for (const session of [alice, bob]) {
      session.ALLOW_V2 = allowV2;
      session.ALLOW_V3 = allowV3;
      session.REQUIRE_ENCRYPTION = true;
      session.SEND_WHITESPACE_TAG = false;
    }
    alice.on('io', (message, meta) => bob.receiveMsg(message, meta));
    bob.on('io', (message, meta) => alice.receiveMsg(message, meta));

    const received = new Promise<{ body: string; encrypted: boolean; meta: unknown }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('OTR handshake timed out')), 5_000);
      bob.on('ui', (body, encrypted, meta) => {
        clearTimeout(timeout);
        resolve({ body, encrypted, meta });
      });
    });

    alice.sendMsg('Привет from legacy OTR', { localId: 'local-1' });
    await expect(received).resolves.toEqual({
      body: 'Привет from legacy OTR',
      encrypted: true,
      meta: { localId: 'local-1' },
    });
    expect(alice.msgstate).toBe(OTR.CONST.MSGSTATE_ENCRYPTED);
    expect(bob.msgstate).toBe(OTR.CONST.MSGSTATE_ENCRYPTED);
    alice.endOtr();
    bob.endOtr();
  }, 10_000);
});
