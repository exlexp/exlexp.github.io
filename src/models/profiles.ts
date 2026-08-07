import {
  createLocalProfile,
  initialsFor,
  type LocalProfile,
  type VaultData,
  type VaultSettings,
} from './types';

interface LegacyVaultData {
  schemaVersion: 1;
  createdAt: number;
  accounts: LocalProfile['accounts'];
  contacts: LocalProfile['contacts'];
  conversations: LocalProfile['conversations'];
  messages: LocalProfile['messages'];
  linkedIdentities: LocalProfile['linkedIdentities'];
  settings: VaultSettings;
}

export function migrateVaultData(value: unknown): VaultData {
  if (!value || typeof value !== 'object') throw new Error('Invalid vault data');
  const schemaVersion = (value as { schemaVersion?: number }).schemaVersion;
  if (schemaVersion === 2 && Array.isArray((value as { profiles?: unknown }).profiles)) return normalizeVault(value as VaultData);
  if (schemaVersion === 1) {
    const candidate = value as LegacyVaultData;
    const profile = createLocalProfile(candidate.settings.language === 'ru' ? 'Личный' : 'Personal', 0);
    profile.accounts = candidate.accounts ?? [];
    profile.contacts = candidate.contacts ?? [];
    profile.conversations = candidate.conversations ?? [];
    profile.messages = candidate.messages ?? [];
    profile.linkedIdentities = candidate.linkedIdentities ?? [];
    return {
      schemaVersion: 2,
      createdAt: candidate.createdAt ?? Date.now(),
      activeProfileId: profile.id,
      profiles: [profile],
      plugins: [],
      settings: candidate.settings,
    };
  }
  throw new Error('Unsupported vault schema');
}

export function normalizeVault(data: VaultData): VaultData {
  data.plugins ??= [];
  if (data.profiles.length === 0) {
    const profile = createLocalProfile(data.settings.language === 'ru' ? 'Личный' : 'Personal', 0);
    data.profiles.push(profile);
    data.activeProfileId = profile.id;
  }
  data.profiles.forEach((profile, index) => {
    profile.order = Number.isFinite(profile.order) ? profile.order : index;
    profile.initials = profile.initials || initialsFor(profile.name);
    profile.drafts ??= {};
    profile.friendRequests ??= [];
    profile.ui ??= { lastChannelByConversation: {}, lastActiveAt: Date.now() };
    profile.omemoAccounts ??= {};
    profile.ui.lastChannelByConversation ??= {};
    profile.settings ??= {
      statusMessage: '',
      connectionPolicy: 'background',
      defaultEncryptionPolicy: 'secure-auto',
    };
    profile.settings.defaultEncryptionPolicy ??= 'secure-auto';
    profile.runtimeState ??= 'disconnected';
    profile.locked ??= false;
    profile.ephemeral ??= false;
    profile.pinned ??= false;
    for (const account of profile.accounts) account.connectionState ??= account.presence === 'online' ? 'online' : 'offline';
  });
  if (!data.profiles.some((profile) => profile.id === data.activeProfileId)) data.activeProfileId = data.profiles[0]!.id;
  return data;
}

export function activeProfile(data: VaultData): LocalProfile {
  const profile = data.profiles.find((item) => item.id === data.activeProfileId);
  if (!profile) throw new Error('Active profile is unavailable');
  return profile;
}

export function createProfile(data: VaultData, name: string, ephemeral = false): string {
  const profile = createLocalProfile(name.trim() || `Profile ${data.profiles.length + 1}`, data.profiles.length, ephemeral);
  data.profiles.push(profile);
  return profile.id;
}

export function renameProfile(profile: LocalProfile, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Profile name cannot be empty');
  profile.name = trimmed;
  profile.initials = initialsFor(trimmed);
}

export function duplicateProfileSettings(data: VaultData, sourceId: string, name: string): string {
  const source = data.profiles.find((profile) => profile.id === sourceId);
  if (!source) throw new Error('Source profile does not exist');
  const id = createProfile(data, name, false);
  const target = data.profiles.find((profile) => profile.id === id)!;
  target.settings = structuredClone(source.settings);
  return id;
}

export function deleteProfile(data: VaultData, id: string): void {
  if (data.profiles.length === 1) throw new Error('The last profile cannot be deleted');
  const index = data.profiles.findIndex((profile) => profile.id === id);
  if (index < 0) return;
  data.profiles.splice(index, 1);
  data.profiles.forEach((profile, order) => { profile.order = order; });
  if (data.activeProfileId === id) data.activeProfileId = data.profiles[0]!.id;
}

export function reorderProfiles(data: VaultData, draggedId: string, targetId: string): void {
  const ordered = [...data.profiles].sort((left, right) => left.order - right.order);
  const sourceIndex = ordered.findIndex((profile) => profile.id === draggedId);
  const targetIndex = ordered.findIndex((profile) => profile.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return;
  const [source] = ordered.splice(sourceIndex, 1);
  if (!source) return;
  ordered.splice(targetIndex, 0, source);
  ordered.forEach((profile, index) => { profile.order = index; });
  data.profiles = ordered;
}

export function aggregateUnread(profile: LocalProfile): number {
  return profile.conversations.reduce((count, conversation) => count + conversation.unread, 0);
}

export function serializableVault(data: VaultData): VaultData {
  const copy = structuredClone(data);
  copy.profiles = copy.profiles.filter((profile) => !profile.ephemeral);
  if (copy.profiles.length === 0) {
    const fallback = createLocalProfile(copy.settings.language === 'ru' ? 'Личный' : 'Personal', 0);
    copy.profiles.push(fallback);
  }
  if (!copy.profiles.some((profile) => profile.id === copy.activeProfileId)) copy.activeProfileId = copy.profiles[0]!.id;
  return copy;
}
