export type Protocol = 'tox' | 'xmpp';
export type Presence = 'online' | 'away' | 'busy' | 'offline';
export type AccountConnectionState = 'offline' | 'starting' | 'connecting' | 'authenticating' | 'online' | 'reconnecting' | 'error';
export type DeliveryState = 'sending' | 'sent' | 'delivered' | 'failed';
export type ConnectionPolicy = 'background' | 'sleep' | 'disconnect';
export type ProfileRuntimeState = 'active' | 'background' | 'sleeping' | 'disconnected' | 'locked';
export type EncryptionProviderId = 'tox' | 'omemo' | 'otr' | 'plaintext';
export type EncryptionPolicy = 'secure-auto' | 'force-omemo' | 'force-otr' | 'plaintext';
export type DeviceTrust = 'trusted' | 'untrusted' | 'ignored';
export type PluginPermission = 'commands' | 'message-metadata' | 'contacts-summary';

export interface PluginCommand {
  id: string;
  title: string;
  action: 'open-chats' | 'open-accounts' | 'open-contacts' | 'open-settings';
}

export interface PluginManifest {
  apiVersion: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  permissions: PluginPermission[];
  commands?: PluginCommand[];
}

export interface InstalledPlugin {
  manifest: PluginManifest;
  enabled: boolean;
  grantedPermissions: PluginPermission[];
  installedAt: number;
}

export interface Account {
  id: string;
  protocol: Protocol;
  address: string;
  alias: string;
  endpoint?: string;
  secret?: string;
  savedata?: string;
  mamEnabled?: boolean;
  presence: Presence;
  connectionState?: AccountConnectionState;
  connectionDetail?: string;
  enabled: boolean;
}

export interface Contact {
  id: string;
  accountId: string;
  protocol: Protocol;
  address: string;
  alias: string;
  presence: Presence;
  remoteId?: string;
  resource?: string;
}

export interface FriendRequest {
  id: string;
  accountId: string;
  protocol: 'tox';
  publicKey: string;
  message: string;
  receivedAt: number;
}

export interface EncryptionDevice {
  id: string;
  label: string;
  fingerprint: string;
  trust: DeviceTrust;
  firstSeenAt: number;
  changedAt?: number;
}

export interface ConversationEncryption {
  policy: EncryptionPolicy;
  provider: EncryptionProviderId;
  verified: boolean;
  devices: EncryptionDevice[];
  warning?: 'first-use' | 'changed-device' | 'stale-device' | 'tls-only' | 'plaintext' | 'unavailable';
  skippedDevices?: number;
}

export interface Conversation {
  id: string;
  contactId: string;
  protocol: Protocol;
  title: string;
  unread: number;
  updatedAt: number;
  sourceAccountId?: string;
  encryption?: ConversationEncryption;
}

export interface Message {
  id: string;
  conversationId: string;
  direction: 'incoming' | 'outgoing';
  body: string;
  timestamp: number;
  delivery: DeliveryState;
  sourceAccountId?: string;
  encryptionProvider?: EncryptionProviderId;
  protocolMessageId?: string;
  protocolPeerId?: string;
}

export interface ProfileSettings {
  languageOverride?: 'ru' | 'en';
  themeOverride?: 'dark' | 'light';
  statusMessage: string;
  connectionPolicy: ConnectionPolicy;
  defaultEncryptionPolicy: EncryptionPolicy;
}

export interface ProfileUiState {
  lastConversationId?: string;
  lastChannelByConversation: Record<string, string>;
  lastActiveAt: number;
}

export type OmemoStoredValue =
  | { kind: 'number'; value: number }
  | { kind: 'text'; value: string }
  | { kind: 'bytes'; value: string }
  | { kind: 'keypair'; publicKey: string; privateKey: string };

export interface OmemoAccountState {
  version: 1;
  deviceId: number;
  signedPreKeyId: number;
  signedPreKeySignature: string;
  store: Record<string, OmemoStoredValue>;
  legacySignedPreKeyId?: number;
  legacySignedPreKeySignature?: string;
  legacyStore?: Record<string, OmemoStoredValue>;
}

export interface OtrAccountState {
  version: 1;
  privateKey: string;
  instanceTag: string;
  fingerprint: string;
}

export interface LocalProfile {
  id: string;
  name: string;
  avatar?: string;
  initials: string;
  order: number;
  pinned: boolean;
  ephemeral: boolean;
  locked: boolean;
  createdAt: number;
  runtimeState: ProfileRuntimeState;
  accounts: Account[];
  contacts: Contact[];
  friendRequests: FriendRequest[];
  conversations: Conversation[];
  messages: Message[];
  drafts: Record<string, string>;
  linkedIdentities: Array<{ id: string; contactIds: string[] }>;
  settings: ProfileSettings;
  ui: ProfileUiState;
  omemoAccounts: Record<string, OmemoAccountState>;
  otrAccounts: Record<string, OtrAccountState>;
}

export interface VaultSettings {
  language: 'ru' | 'en';
  theme: 'dark' | 'light';
  autoLockMinutes: number;
  retainHistory: boolean;
  showNotificationPreviews: boolean;
  debugEnabled: boolean;
}

export interface VaultData {
  schemaVersion: 2;
  createdAt: number;
  activeProfileId: string;
  profiles: LocalProfile[];
  plugins: InstalledPlugin[];
  settings: VaultSettings;
}

export function initialsFor(name: string): string {
  const pieces = name.trim().split(/\s+/).filter(Boolean);
  return (pieces.length > 1 ? `${pieces[0]?.[0] ?? ''}${pieces[1]?.[0] ?? ''}` : name.slice(0, 2)).toUpperCase() || 'RL';
}

export function createLocalProfile(name: string, order: number, ephemeral = false): LocalProfile {
  const id = crypto.randomUUID();
  return {
    id,
    name,
    initials: initialsFor(name),
    order,
    pinned: false,
    ephemeral,
    locked: false,
    createdAt: Date.now(),
    runtimeState: 'active',
    accounts: [],
    contacts: [],
    friendRequests: [],
    conversations: [],
    messages: [],
    drafts: {},
    linkedIdentities: [],
    settings: {
      statusMessage: '',
      connectionPolicy: 'background',
      defaultEncryptionPolicy: 'secure-auto',
    },
    ui: { lastChannelByConversation: {}, lastActiveAt: Date.now() },
    omemoAccounts: {},
    otrAccounts: {},
  };
}

export function createEmptyVault(language: 'ru' | 'en'): VaultData {
  const profile = createLocalProfile(language === 'ru' ? 'Личный' : 'Personal', 0);
  return {
    schemaVersion: 2,
    createdAt: Date.now(),
    activeProfileId: profile.id,
    profiles: [profile],
    plugins: [],
    settings: {
      language,
      theme: 'dark',
      autoLockMinutes: 15,
      retainHistory: true,
      showNotificationPreviews: false,
      debugEnabled: false,
    },
  };
}
