import type { EncryptionPolicy, EncryptionProviderId } from '../models/types';

export interface EncryptionContext {
  profileId: string;
  accountId: string;
  conversationId: string;
  recipient: string;
}

export interface EncryptedPayload {
  provider: EncryptionProviderId;
  body: string;
  wireBody: string;
  metadata?: Record<string, string>;
}

export interface EncryptionProvider {
  readonly id: EncryptionProviderId;
  readonly available: boolean;
  readonly supportsMultiDevice: boolean;
  encrypt(context: EncryptionContext, plaintext: string): Promise<EncryptedPayload>;
  decrypt(context: EncryptionContext, payload: EncryptedPayload): Promise<string>;
  closeProfile(profileId: string): Promise<void>;
}

export class PlaintextProvider implements EncryptionProvider {
  readonly id = 'plaintext' as const;
  readonly available = true;
  readonly supportsMultiDevice = false;

  async encrypt(_context: EncryptionContext, plaintext: string): Promise<EncryptedPayload> {
    return { provider: 'plaintext', body: plaintext, wireBody: plaintext };
  }

  async decrypt(_context: EncryptionContext, payload: EncryptedPayload): Promise<string> {
    if (payload.provider !== 'plaintext') throw new Error('Plaintext provider cannot decrypt another provider payload');
    return payload.wireBody;
  }

  async closeProfile(_profileId: string): Promise<void> {}
}

export class UnavailableEncryptionProvider implements EncryptionProvider {
  readonly available = false;
  constructor(
    readonly id: 'omemo' | 'otr',
    readonly supportsMultiDevice: boolean,
  ) {}

  async encrypt(): Promise<EncryptedPayload> {
    throw new Error(`${this.id.toUpperCase()} provider is not installed; encrypted sending was refused`);
  }

  async decrypt(): Promise<string> {
    throw new Error(`${this.id.toUpperCase()} provider is not installed`);
  }

  async closeProfile(_profileId: string): Promise<void> {}
}

export interface ProviderAvailability {
  omemo: boolean;
  otr: boolean;
}

export class PlaintextConfirmationRequired extends Error {
  constructor() {
    super('No end-to-end encryption provider is available; explicit plaintext confirmation is required');
  }
}

export function resolveEncryptionProvider(
  policy: EncryptionPolicy,
  availability: ProviderAvailability,
  plaintextConfirmed = false,
): EncryptionProviderId {
  if (policy === 'force-omemo') {
    if (!availability.omemo) throw new Error('OMEMO is required but unavailable; message was not sent');
    return 'omemo';
  }
  if (policy === 'force-otr') {
    if (!availability.otr) throw new Error('OTR is required but unavailable; message was not sent');
    return 'otr';
  }
  if (policy === 'plaintext') {
    if (!plaintextConfirmed) throw new PlaintextConfirmationRequired();
    return 'plaintext';
  }
  if (availability.omemo) return 'omemo';
  if (availability.otr) return 'otr';
  throw new Error('End-to-end encryption is unavailable; message was not sent');
}
