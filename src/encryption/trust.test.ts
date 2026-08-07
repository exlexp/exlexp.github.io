import { describe, expect, it } from 'vitest';
import type { ConversationEncryption } from '../models/types';
import { registerDevice, setDeviceTrust } from './trust';

function state(): ConversationEncryption {
  return { policy: 'force-omemo', provider: 'omemo', verified: false, devices: [] };
}

describe('OMEMO trust state', () => {
  it('marks first use untrusted and requires explicit verification', () => {
    const encryption = state();
    expect(registerDevice(encryption, { id: '1', label: 'Phone', fingerprint: 'AAAA' }, 1)).toBe('new');
    expect(encryption.warning).toBe('first-use');
    setDeviceTrust(encryption, '1', 'trusted');
    expect(encryption.verified).toBe(true);
  });

  it('revokes trust when a device fingerprint changes', () => {
    const encryption = state();
    registerDevice(encryption, { id: '1', label: 'Phone', fingerprint: 'AAAA' }, 1);
    setDeviceTrust(encryption, '1', 'trusted');
    expect(registerDevice(encryption, { id: '1', label: 'Phone', fingerprint: 'BBBB' }, 2)).toBe('changed');
    expect(encryption).toMatchObject({ verified: false, warning: 'changed-device' });
    expect(encryption.devices[0]?.trust).toBe('untrusted');
  });
});
