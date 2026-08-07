import { describe, expect, it } from 'vitest';
import { conversationMatchesQuery, ensureConversation, recordIncomingActivity } from './conversations';
import { createEmptyVault } from './types';

describe('conversations', () => {
  it('opens one stable conversation for a contact with an explicit source account', () => {
    const profile = createEmptyVault('en').profiles[0]!;
    profile.accounts.push({ id: 'xmpp', protocol: 'xmpp', address: 'me@example.org', alias: 'Me', presence: 'online', enabled: true });
    profile.contacts.push({ id: 'contact', accountId: 'xmpp', protocol: 'xmpp', address: 'friend@example.org', alias: 'Friend', presence: 'online' });
    const first = ensureConversation(profile, 'contact', 10);
    const second = ensureConversation(profile, 'contact', 20);
    expect(second.id).toBe(first.id);
    expect(first.sourceAccountId).toBe('xmpp');
    expect(first.encryption?.warning).toBe('tls-only');
    expect(profile.conversations).toHaveLength(1);
  });

  it('uses a preallocated conversation id for immediate contact navigation', () => {
    const profile = createEmptyVault('en').profiles[0]!;
    profile.contacts.push({ id: 'contact', accountId: 'tox', protocol: 'tox', address: 'ABCDEF', alias: 'Alice', presence: 'offline' });
    expect(ensureConversation(profile, 'contact', 10, 'optimistic-chat').id).toBe('optimistic-chat');
  });

  it('searches titles, addresses and local message text', () => {
    const profile = createEmptyVault('en').profiles[0]!;
    profile.contacts.push({ id: 'contact', accountId: 'tox', protocol: 'tox', address: 'ABCDEF', alias: 'Alice', presence: 'offline' });
    const conversation = ensureConversation(profile, 'contact', 10);
    profile.messages.push({ id: 'message', conversationId: conversation.id, direction: 'incoming', body: 'Project lighthouse', timestamp: 11, delivery: 'delivered' });
    expect(conversationMatchesQuery(profile, conversation, 'alice')).toBe(true);
    expect(conversationMatchesQuery(profile, conversation, 'abcdef')).toBe(true);
    expect(conversationMatchesQuery(profile, conversation, 'lighthouse')).toBe(true);
    expect(conversationMatchesQuery(profile, conversation, 'missing')).toBe(false);
  });

  it('does not create phantom unread counts in the visible conversation', () => {
    const profile = createEmptyVault('en').profiles[0]!;
    profile.contacts.push({ id: 'contact', accountId: 'tox', protocol: 'tox', address: 'ABCDEF', alias: 'Alice', presence: 'online' });
    const conversation = ensureConversation(profile, 'contact', 10);
    conversation.unread = 2;
    recordIncomingActivity(conversation, true, 20);
    expect(conversation.unread).toBe(0);
    recordIncomingActivity(conversation, false, 30);
    expect(conversation.unread).toBe(1);
    expect(conversation.updatedAt).toBe(30);
  });
});
