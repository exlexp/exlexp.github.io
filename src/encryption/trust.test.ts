import { describe, expect, it } from 'vitest';
import type { ConversationEncryption } from '../models/types';
import { reconcileDeviceSnapshot, registerDevice, setDeviceTrust } from './trust';

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

  it('blocks silent encryption to a new device after a fingerprint was verified', () => {
    const previous = [{ id: 'alice:1', label: 'Phone', fingerprint: 'AAAA', trust: 'trusted' as const, firstSeenAt: 1 }];
    const result = reconcileDeviceSnapshot(previous, [
      { id: 'alice:1', label: 'Phone', fingerprint: 'AAAA' },
      { id: 'alice:2', label: 'Laptop', fingerprint: 'BBBB' },
    ], 2);
    expect(result).toMatchObject({ verified: false, requiresTrustReview: true, changed: false });
    expect(result.devices[1]?.trust).toBe('untrusted');
  });

  it('revokes verified trust when a device id is reused with another key', () => {
    const previous = [{ id: 'alice:1', label: 'Phone', fingerprint: 'AAAA', trust: 'trusted' as const, firstSeenAt: 1 }];
    const result = reconcileDeviceSnapshot(previous, [{ id: 'alice:1', label: 'Phone', fingerprint: 'CCCC' }], 3);
    expect(result).toMatchObject({ verified: false, requiresTrustReview: true, changed: true });
    expect(result.devices[0]).toMatchObject({ trust: 'untrusted', changedAt: 3 });
  });
});
