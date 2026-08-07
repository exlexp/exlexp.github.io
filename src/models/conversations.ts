import type { Conversation, LocalProfile } from './types';

export function ensureConversation(profile: LocalProfile, contactId: string, now = Date.now()): Conversation {
  const contact = profile.contacts.find((item) => item.id === contactId);
  if (!contact) throw new Error('Contact does not exist');
  const existing = profile.conversations.find((item) => item.contactId === contactId);
  if (existing) {
    existing.title = contact.alias;
    existing.sourceAccountId ??= contact.accountId;
    return existing;
  }
  const conversation: Conversation = {
    id: crypto.randomUUID(),
    contactId,
    protocol: contact.protocol,
    title: contact.alias,
    unread: 0,
    updatedAt: now,
    sourceAccountId: contact.accountId,
    encryption: contact.protocol === 'tox'
      ? { policy: 'secure-auto', provider: 'tox', verified: true, devices: [] }
      : { policy: profile.settings.defaultEncryptionPolicy, provider: 'plaintext', verified: false, devices: [], warning: 'tls-only' },
  };
  profile.conversations.push(conversation);
  return conversation;
}

export function conversationMatchesQuery(profile: LocalProfile, conversation: Conversation, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  const contact = profile.contacts.find((item) => item.id === conversation.contactId);
  if (`${profile.name} ${conversation.title} ${contact?.alias ?? ''} ${contact?.address ?? ''}`.toLocaleLowerCase().includes(needle)) return true;
  return profile.messages.some((message) => message.conversationId === conversation.id && message.body.toLocaleLowerCase().includes(needle));
}

export function recordIncomingActivity(conversation: Conversation, visible: boolean, timestamp: number): void {
  conversation.updatedAt = timestamp;
  conversation.unread = visible ? 0 : conversation.unread + 1;
}
