import type { ConversationEncryption, DeviceTrust, EncryptionDevice } from '../models/types';

export function registerDevice(
  encryption: ConversationEncryption,
  input: Pick<EncryptionDevice, 'id' | 'label' | 'fingerprint'>,
  now = Date.now(),
): 'new' | 'unchanged' | 'changed' {
  const current = encryption.devices.find((device) => device.id === input.id);
  if (!current) {
    encryption.devices.push({ ...input, trust: 'untrusted', firstSeenAt: now });
    encryption.verified = false;
    encryption.warning = 'first-use';
    return 'new';
  }
  if (current.fingerprint !== input.fingerprint) {
    current.fingerprint = input.fingerprint;
    current.label = input.label;
    current.trust = 'untrusted';
    current.changedAt = now;
    encryption.verified = false;
    encryption.warning = 'changed-device';
    return 'changed';
  }
  current.label = input.label;
  return 'unchanged';
}

export function setDeviceTrust(
  encryption: ConversationEncryption,
  deviceId: string,
  trust: DeviceTrust,
): void {
  const device = encryption.devices.find((item) => item.id === deviceId);
  if (!device) throw new Error('OMEMO device does not exist');
  device.trust = trust;
  const relevant = encryption.devices.filter((item) => item.trust !== 'ignored');
  encryption.verified = relevant.length > 0 && relevant.every((item) => item.trust === 'trusted');
  if (encryption.verified) encryption.warning = undefined;
}

export function formatFingerprint(value: string): string {
  return value.replace(/[^a-fA-F0-9]/g, '').toUpperCase().match(/.{1,8}/g)?.join(' ') ?? '';
}
