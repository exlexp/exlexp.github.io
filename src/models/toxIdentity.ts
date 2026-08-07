import type { LocalProfile } from './types';
import type { ToxFriend } from '../protocols/tox/types';

function normalizedKey(value: string): string {
  return value.trim().toUpperCase();
}

export function reconcileToxFriends(profile: LocalProfile, accountId: string, friends: ToxFriend[]): void {
  const activeKeys = new Set(friends.map((friend) => normalizedKey(friend.publicKey)));
  for (const contact of profile.contacts) {
    if (contact.protocol === 'tox' && contact.accountId === accountId && !contact.address.startsWith('friend:') && !activeKeys.has(normalizedKey(contact.address))) {
      contact.remoteId = undefined;
      contact.presence = 'offline';
    }
  }
  for (const friend of friends) resolveToxContact(profile, accountId, friend.friendNumber, friend.publicKey, true);
}

export function resolveToxContact(profile: LocalProfile, accountId: string, friendNumber: number, publicKey: string, create = true) {
  const key = normalizedKey(publicKey);
  const remoteId = String(friendNumber);
  let contact = profile.contacts.find((item) => item.protocol === 'tox' && item.accountId === accountId && normalizedKey(item.address) === key);
  const numberOwner = profile.contacts.find((item) => item.protocol === 'tox' && item.accountId === accountId && item.remoteId === remoteId);
  if (numberOwner && numberOwner !== contact) {
    if (numberOwner.address.startsWith('friend:')) {
      numberOwner.address = key;
      contact = numberOwner;
    } else {
      numberOwner.remoteId = undefined;
      numberOwner.presence = 'offline';
    }
  }
  if (!contact && create) {
    contact = {
      id: crypto.randomUUID(), accountId, protocol: 'tox', address: key,
      alias: `Tox ${key.slice(0, 8)}`, presence: 'offline', remoteId,
    };
    profile.contacts.push(contact);
  }
  if (contact) contact.remoteId = remoteId;
  return contact;
}
