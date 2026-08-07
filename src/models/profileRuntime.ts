import type { Account, Conversation, LocalProfile, VaultData } from './types';

export interface ProfileSwitchResult {
  previousProfileId: string;
  targetProfileId: string;
  stopAccountIds: string[];
  restoreConversationId?: string;
}

export function switchProfileState(data: VaultData, targetProfileId: string, now = Date.now()): ProfileSwitchResult {
  const previous = data.profiles.find((profile) => profile.id === data.activeProfileId);
  const target = data.profiles.find((profile) => profile.id === targetProfileId);
  if (!previous || !target) throw new Error('Profile does not exist');
  if (target.locked) throw new Error('Profile is locked');
  const stopAccountIds = previous.id === target.id || previous.settings.connectionPolicy === 'background'
    ? []
    : previous.accounts.map((account) => account.id);
  if (previous.id !== target.id) {
    previous.runtimeState = previous.settings.connectionPolicy === 'background'
      ? 'background'
      : previous.settings.connectionPolicy === 'sleep'
        ? 'sleeping'
        : 'disconnected';
    previous.ui.lastActiveAt = now;
  }
  target.runtimeState = 'active';
  target.ui.lastActiveAt = now;
  data.activeProfileId = target.id;
  return { previousProfileId: previous.id, targetProfileId: target.id, stopAccountIds, restoreConversationId: target.ui.lastConversationId };
}

export function requireSourceIdentity(
  data: VaultData,
  profileId: string,
  conversation: Conversation,
  accountId: string,
): { profile: LocalProfile; account: Account } {
  if (data.activeProfileId !== profileId) throw new Error('Sending from an inactive profile was refused');
  const profile = data.profiles.find((item) => item.id === profileId);
  if (!profile || profile.locked) throw new Error('Profile is unavailable');
  const account = profile.accounts.find((item) => item.id === accountId);
  if (!account || account.protocol !== conversation.protocol) throw new Error('Select an explicit compatible source identity');
  return { profile, account };
}
