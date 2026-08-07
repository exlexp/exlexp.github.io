import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BRAND } from '../config/branding';
import { activeProfile, createProfile, deleteProfile, duplicateProfileSettings, reorderProfiles } from '../models/profiles';
import { conversationMatchesQuery, ensureConversation, recordIncomingActivity } from '../models/conversations';
import { requireSourceIdentity, switchProfileState } from '../models/profileRuntime';
import type { Account, Conversation, LocalProfile, Message, PluginPermission, ProfileSettings, VaultData } from '../models/types';
import { networkPolicy, type NetworkActivity } from '../network/policy';
import { XmppClient } from '../protocols/xmpp/client';
import { ToxClient } from '../protocols/tox/client';
import { hasToxTransport } from '../protocols/tox/gatewayConfig';
import type { ToxEvent } from '../protocols/tox/types';
import { availablePluginCommands, installPlugin, parsePluginManifest } from '../plugins/host';
import { redactError } from '../security/redaction';
import { Vault } from '../security/vault';
import { copy, type Language } from './i18n';
import { AccountsIcon, ArrowIcon, ChatIcon, ContactsIcon, DeliveredIcon, DownloadIcon, FailedIcon, LockIcon, PendingIcon, PluginsIcon, PlusIcon, SearchIcon, SendIcon, SentIcon, SettingsIcon, ShieldIcon, ToxIcon, UserIcon, XmppIcon } from './icons';
import { CommandPalette } from './CommandPalette';
import { ProfileRail, type ProfileScope } from './ProfileRail';
import { PlaintextConfirmationRequired, resolveEncryptionProvider } from '../encryption/provider';
import { requestLocalNotifications, showLocalMessageNotification } from './notifications';
import { XmppAccountSetup } from './XmppAccountSetup';

type Screen = 'chats' | 'accounts' | 'contacts' | 'privacy' | 'plugins' | 'settings';
type Gate = 'loading' | 'launch' | 'unlock' | 'open';

const vault = new Vault();

export function App() {
  const [gate, setGate] = useState<Gate>('loading');
  const [language, setLanguage] = useState<Language>('ru');
  const [data, setData] = useState<VaultData>();
  const [screen, setScreen] = useState<Screen>('chats');
  const [error, setError] = useState('');
  const [selectedConversation, setSelectedConversation] = useState<string>();
  const [network, setNetwork] = useState<NetworkActivity[]>([]);
  const [profileScope, setProfileScope] = useState<ProfileScope>('all');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const xmppClients = useRef(new Map<string, XmppClient>());
  const toxClients = useRef(new Map<string, ToxClient>());
  const toxSavedata = useRef(new Map<string, string>());
  const viewState = useRef<{ activeProfileId?: string; screen: Screen; conversationId?: string }>({ screen: 'chats' });
  const t = copy[language];

  useEffect(() => { viewState.current = { activeProfileId: data?.activeProfileId, screen, conversationId: selectedConversation }; }, [data?.activeProfileId, screen, selectedConversation]);

  useEffect(() => {
    void vault.exists().then((exists) => setGate(exists ? 'unlock' : 'launch')).catch((reason) => {
      setError(redactError(reason)); setGate('launch');
    });
    return networkPolicy.subscribe(setNetwork);
  }, []);

  useEffect(() => () => {
    for (const client of xmppClients.current.values()) client.stop();
    for (const client of toxClients.current.values()) void client.stop();
  }, []);

  useEffect(() => {
    if (gate !== 'open' || !data) return;
    const handler = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === 'k') {
        event.preventDefault(); setPaletteOpen((open) => !open); return;
      }
      if (event.ctrlKey && /^[1-9]$/.test(event.key)) {
        const profile = [...data.profiles].sort((a, b) => a.order - b.order)[Number(event.key) - 1];
        if (profile) { event.preventDefault(); void selectProfile(profile.id); }
        return;
      }
      if (event.ctrlKey && event.key === 'Tab') {
        event.preventDefault();
        const profiles = [...data.profiles].sort((a, b) => a.order - b.order);
        const current = profiles.findIndex((profile) => profile.id === data.activeProfileId);
        const delta = event.shiftKey ? -1 : 1;
        const next = profiles[(current + delta + profiles.length) % profiles.length];
        if (next) void selectProfile(next.id);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [data, gate]);

  useEffect(() => {
    if (gate !== 'open' || !data || data.settings.autoLockMinutes <= 0) return;
    let timer = window.setTimeout(lock, data.settings.autoLockMinutes * 60_000);
    const arm = () => { window.clearTimeout(timer); timer = window.setTimeout(lock, data.settings.autoLockMinutes * 60_000); };
    window.addEventListener('pointerdown', arm, { passive: true });
    window.addEventListener('keydown', arm);
    return () => { window.clearTimeout(timer); window.removeEventListener('pointerdown', arm); window.removeEventListener('keydown', arm); };
  }, [data?.settings.autoLockMinutes, gate]);

  useEffect(() => {
    if (gate !== 'open' || !data) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      for (const profile of data.profiles) {
        if (profile.locked || (profile.id !== data.activeProfileId && profile.settings.connectionPolicy !== 'background')) continue;
        for (const account of profile.accounts.filter((item) => item.enabled)) {
          if (account.protocol === 'xmpp') connectXmpp(account, profile.id);
          else void connectTox(account, profile.id).catch(() => undefined);
        }
      }
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [gate, data?.activeProfileId]);

  const refresh = useCallback(() => {
    const snapshot = vault.snapshot;
    setData(snapshot);
    setLanguage(snapshot.settings.language);
    setProfileScope((scope) => scope === 'all' || snapshot.profiles.some((profile) => profile.id === scope) ? scope : snapshot.activeProfileId);
  }, []);

  const createPersistent = async (password: string) => {
    setError('');
    try { await vault.create(password, language); refresh(); setGate('open'); }
    catch (reason) { setError(redactError(reason)); }
  };

  const createEphemeral = () => { vault.createEphemeral(language); refresh(); setGate('open'); };

  const unlock = async (password: string) => {
    setError('');
    try { await vault.unlock(password); refresh(); setGate('open'); }
    catch (reason) { setError(redactError(reason)); }
  };

  function lock() {
    for (const client of xmppClients.current.values()) client.stop();
    for (const client of toxClients.current.values()) void client.stop();
    xmppClients.current.clear(); toxClients.current.clear(); vault.lock(); setData(undefined); setGate('unlock');
  }

  if (gate === 'loading') return <div className="boot"><span className="pulse"/> {BRAND.productName} / LOCAL BOOT</div>;
  if (gate === 'launch') return <FirstLaunch language={language} setLanguage={setLanguage} error={error} createPersistent={createPersistent} createEphemeral={createEphemeral}/>;
  if (gate === 'unlock') return <Unlock language={language} setLanguage={setLanguage} error={error} unlock={unlock}/>;
  if (!data) return null;

  const currentProfile = activeProfile(data);

  async function selectProfile(profileId: string) {
    if (!data) return;
    const target = data.profiles.find((profile) => profile.id === profileId);
    if (!target) return;
    if (target.locked) {
      if (!window.confirm(`Unlock local profile “${target.name}” inside the open vault?`)) return;
      await vault.update((draft) => { const profile = draft.profiles.find((item) => item.id === profileId); if (profile) { profile.locked = false; profile.runtimeState = 'disconnected'; } });
    }
    let previousId = data.activeProfileId;
    let stopAccountIds: string[] = [];
    await vault.update((draft) => {
      const result = switchProfileState(draft, profileId);
      previousId = result.previousProfileId; stopAccountIds = result.stopAccountIds;
    });
    for (const accountId of stopAccountIds) {
      const key = `${previousId}:${accountId}`;
      xmppClients.current.get(key)?.stop(); xmppClients.current.delete(key);
      void toxClients.current.get(key)?.stop(); toxClients.current.delete(key);
    }
    refresh(); setProfileScope(profileId); setSelectedConversation(target.ui.lastConversationId); setScreen('chats');
  }

  async function createNewProfile(ephemeral = false) {
    const name = window.prompt(ephemeral ? 'Temporary profile name' : 'Local profile name');
    if (!name?.trim()) return;
    let id = '';
    await vault.update((draft) => { id = createProfile(draft, name, ephemeral); draft.activeProfileId = id; });
    refresh(); setProfileScope(id); setSelectedConversation(undefined); setScreen('chats');
  }

  const addXmpp = async (account: Account) => {
    const profileId = data.activeProfileId;
    await vault.update((draft) => { draft.profiles.find((profile) => profile.id === profileId)?.accounts.push(account); });
    refresh(); connectXmpp(account, profileId); setScreen('chats');
  };

  const connectXmpp = (account: Account, profileId = data.activeProfileId) => {
    if (!account.endpoint || !account.secret) return;
    const key = `${profileId}:${account.id}`;
    const existing = xmppClients.current.get(key);
    if (existing && account.connectionState !== 'error') return;
    if (existing) { existing.stop(); xmppClients.current.delete(key); }
    const client = new XmppClient();
    client.subscribe((event) => {
      if (event.type === 'state') {
        if (event.state === 'error' && event.detail) setError(event.detail);
        void vault.update((draft) => {
          const profile = draft.profiles.find((item) => item.id === profileId);
          const current = profile?.accounts.find((item) => item.id === account.id);
          if (current) {
            current.presence = event.state === 'online' ? 'online' : 'offline';
            current.connectionState = event.state;
            current.connectionDetail = event.detail;
          }
        }).then(refresh);
      }
      if (event.type === 'roster') {
        void vault.update((draft) => {
          const profile = draft.profiles.find((item) => item.id === profileId); if (!profile) return;
          for (const item of event.contacts) {
            if (!profile.contacts.some((contact) => contact.accountId === account.id && contact.address === item.jid)) {
              profile.contacts.push({ id: crypto.randomUUID(), accountId: account.id, protocol: 'xmpp', address: item.jid, alias: item.name, presence: 'offline' });
            }
          }
        }).then(refresh);
      }
      if (event.type === 'presence') {
        void vault.update((draft) => {
          const contact = draft.profiles.find((item) => item.id === profileId)?.contacts.find((item) => item.accountId === account.id && item.address === event.from);
          if (contact) contact.presence = event.show === 'offline' ? 'offline' : event.show === 'away' || event.show === 'xa' ? 'away' : event.show === 'dnd' ? 'busy' : 'online';
        }).then(refresh);
      }
      if (event.type === 'message') {
        const profileName = vault.snapshot.profiles.find((item) => item.id === profileId)?.name ?? 'Relayless';
        let shouldNotify = false;
        let conversationTitle = event.from;
        void vault.update((draft) => {
          const profile = draft.profiles.find((item) => item.id === profileId); if (!profile) return;
          if (profile.messages.some((item) => item.id === event.id)) return;
          let contact = profile.contacts.find((item) => item.accountId === account.id && item.address === event.from);
          if (!contact) {
            contact = { id: crypto.randomUUID(), accountId: account.id, protocol: 'xmpp', address: event.from, alias: event.from, presence: 'offline' };
            profile.contacts.push(contact);
          }
          let conversation = profile.conversations.find((item) => item.contactId === contact.id);
          if (!conversation) {
            conversation = { id: crypto.randomUUID(), contactId: contact.id, protocol: 'xmpp', title: contact.alias, unread: 0, updatedAt: event.timestamp, sourceAccountId: account.id, encryption: { policy: profile.settings.defaultEncryptionPolicy, provider: 'plaintext', verified: false, devices: [], warning: 'tls-only' } };
            profile.conversations.push(conversation);
          }
          const visible = viewState.current.activeProfileId === profileId && viewState.current.screen === 'chats' && viewState.current.conversationId === conversation.id;
          recordIncomingActivity(conversation, visible, event.timestamp);
          conversationTitle = conversation.title; shouldNotify = !visible;
          profile.messages.push({ id: event.id, conversationId: conversation.id, direction: 'incoming', body: event.body, timestamp: event.timestamp, delivery: 'delivered', sourceAccountId: account.id, encryptionProvider: 'plaintext' });
        }).then(() => { refresh(); if (shouldNotify) showLocalMessageNotification(profileName, conversationTitle, event.body, vault.snapshot.settings.showNotificationPreviews); });
      }
      if (event.type === 'receipt') {
        void vault.update((draft) => { const message = draft.profiles.find((profile) => profile.id === profileId)?.messages.find((item) => item.id === event.id); if (message) message.delivery = 'delivered'; }).then(refresh);
      }
    });
    xmppClients.current.set(key, client);
    void client.start({ jid: account.address, password: account.secret, endpoint: account.endpoint, restoreArchive: account.mamEnabled }).catch((reason) => setError(redactError(reason)));
  };

  const addTox = async (alias: string, savedata?: string) => {
    const profileId = data.activeProfileId;
    const account: Account = {
      id: crypto.randomUUID(), protocol: 'tox', address: '', alias: alias.trim() || 'Tox',
      savedata: savedata?.trim() || undefined, presence: 'offline', connectionState: 'offline', enabled: true,
    };
    await vault.update((draft) => { draft.profiles.find((profile) => profile.id === profileId)?.accounts.push(account); });
    refresh();
    await connectTox(account, profileId).catch(() => undefined);
  };

  const connectTox = async (account: Account, profileId = data.activeProfileId): Promise<ToxClient> => {
    const key = `${profileId}:${account.id}`;
    const transportAvailable = hasToxTransport();
    const unavailableDetail = languageHint(t, 'Шлюз Tox временно недоступен.', 'The Tox gateway is temporarily unavailable.');
    const markUnavailable = async () => {
      await vault.update((draft) => {
        const current = draft.profiles.find((item) => item.id === profileId)?.accounts.find((item) => item.id === account.id);
        if (!current) return;
        current.presence = 'offline';
        current.connectionState = 'error';
        current.connectionDetail = unavailableDetail;
      });
      refresh();
    };
    const existing = toxClients.current.get(key);
    if (!transportAvailable && account.address) {
      if (existing) { await existing.stop().catch(() => undefined); toxClients.current.delete(key); }
      await markUnavailable();
      throw new Error(unavailableDetail);
    }
    if (existing && accountConnectionRunning(account)) return existing;
    if (existing) { await existing.stop(); toxClients.current.delete(key); }
    const client = new ToxClient();
    client.subscribe((event) => handleToxEvent(profileId, account.id, event));
    toxClients.current.set(key, client);
    try {
      await client.start({ savedata: account.savedata, name: account.alias, status: data.profiles.find((item) => item.id === profileId)?.settings.statusMessage });
    } catch (reason) {
      toxClients.current.delete(key);
      await client.stop();
      const detail = redactError(reason);
      await vault.update((draft) => {
        const current = draft.profiles.find((item) => item.id === profileId)?.accounts.find((item) => item.id === account.id);
        if (!current) return;
        current.presence = 'offline';
        current.connectionState = 'error';
        current.connectionDetail = detail;
      });
      refresh(); setError(detail);
      throw reason;
    }
    return client;
  };

  const handleToxEvent = (profileId: string, accountId: string, event: ToxEvent) => {
    const key = `${profileId}:${accountId}`;
    if (event.type === 'savedata' && toxSavedata.current.get(key) === event.savedata) return;
    if (event.type === 'savedata') toxSavedata.current.set(key, event.savedata);
    if (event.type === 'ready') toxSavedata.current.set(key, event.savedata);
    if (event.type === 'message') {
      const snapshot = vault.snapshot;
      const profileName = snapshot.profiles.find((item) => item.id === profileId)?.name ?? 'Relayless';
      let shouldNotify = false;
      let conversationTitle = `Tox ${event.friendNumber + 1}`;
      void vault.update((draft) => {
        const profile = draft.profiles.find((item) => item.id === profileId); if (!profile) return;
        let contact = profile.contacts.find((item) => item.accountId === accountId && item.remoteId === String(event.friendNumber));
        if (!contact) {
          contact = { id: crypto.randomUUID(), accountId, protocol: 'tox', address: `friend:${event.friendNumber}`, alias: `Tox ${event.friendNumber + 1}`, presence: 'online', remoteId: String(event.friendNumber) };
          profile.contacts.push(contact);
        }
        let conversation = profile.conversations.find((item) => item.contactId === contact.id);
        if (!conversation) {
          conversation = { id: crypto.randomUUID(), contactId: contact.id, protocol: 'tox', title: contact.alias, unread: 0, updatedAt: event.timestamp, sourceAccountId: accountId, encryption: { policy: 'secure-auto', provider: 'tox', verified: true, devices: [] } };
          profile.conversations.push(conversation);
        }
        const visible = viewState.current.activeProfileId === profileId && viewState.current.screen === 'chats' && viewState.current.conversationId === conversation.id;
        recordIncomingActivity(conversation, visible, event.timestamp);
        conversationTitle = conversation.title; shouldNotify = !visible;
        profile.messages.push({ id: crypto.randomUUID(), conversationId: conversation.id, direction: 'incoming', body: event.text, timestamp: event.timestamp, delivery: 'delivered', sourceAccountId: accountId, encryptionProvider: 'tox' });
      }).then(() => { refresh(); if (shouldNotify) showLocalMessageNotification(profileName, conversationTitle, event.text, vault.snapshot.settings.showNotificationPreviews); });
      return;
    }
    void vault.update((draft) => {
      const profile = draft.profiles.find((item) => item.id === profileId); if (!profile) return;
      const current = profile.accounts.find((item) => item.id === accountId); if (!current) return;
      if (event.type === 'state') {
        current.presence = event.state === 'online' ? 'online' : 'offline';
        current.connectionState = event.state;
        current.connectionDetail = event.detail;
      }
      if (event.type === 'ready') {
        current.address = event.address; current.savedata = event.savedata;
        for (const friend of event.friends) {
          const existingContact = profile.contacts.find((item) => item.accountId === accountId && item.remoteId === String(friend.friendNumber));
          if (existingContact) existingContact.address = friend.publicKey;
          else profile.contacts.push({ id: crypto.randomUUID(), accountId, protocol: 'tox', address: friend.publicKey, alias: `Tox ${friend.publicKey.slice(0, 8)}`, presence: 'offline', remoteId: String(friend.friendNumber) });
        }
      }
      if (event.type === 'savedata') current.savedata = event.savedata;
      if (event.type === 'transport' && event.transport === 'tcp') {
        if (event.state === 'open') current.connectionDetail = languageHint(t, 'TCP-релей Tox подключён.', 'Tox TCP relay connected.');
        if (event.state === 'error') current.connectionDetail = languageHint(t, 'Переключаем Tox-релей…', 'Switching Tox relay…');
      }
      if (event.type === 'friend-request' && !profile.friendRequests.some((item) => item.accountId === accountId && item.publicKey === event.publicKey)) {
        profile.friendRequests.push({ id: crypto.randomUUID(), accountId, protocol: 'tox', publicKey: event.publicKey, message: event.message, receivedAt: Date.now() });
      }
      if (event.type === 'friend-connection') {
        const contact = profile.contacts.find((item) => item.accountId === accountId && item.remoteId === String(event.friendNumber));
        if (contact) contact.presence = event.online ? 'online' : 'offline';
      }
      if (event.type === 'receipt') {
        const message = profile.messages.find((item) => item.id === `tox:${accountId}:${event.messageId}`);
        if (message) message.delivery = 'delivered';
      }
    }).then(refresh).catch((reason) => setError(redactError(reason)));
  };

  const addXmppContact = async (accountId: string, address: string, alias: string): Promise<string> => {
    const profileId = data.activeProfileId;
    const account = activeProfile(data).accounts.find((item) => item.id === accountId && item.protocol === 'xmpp');
    if (!account) throw new Error(languageHint(t, 'XMPP-аккаунт не найден.', 'XMPP account was not found.'));
    const client = xmppClients.current.get(`${profileId}:${accountId}`);
    if (!client || account.presence !== 'online') throw new Error(languageHint(t, 'Сначала подключите XMPP-аккаунт.', 'Connect the XMPP account first.'));
    const jid = client.addContact(address, alias);
    let contactId = '';
    await vault.update((draft) => {
      const profile = draft.profiles.find((item) => item.id === profileId); if (!profile) return;
      let contact = profile.contacts.find((item) => item.accountId === accountId && item.address === jid);
      if (!contact) {
        contact = { id: crypto.randomUUID(), accountId, protocol: 'xmpp', address: jid, alias: alias.trim() || jid, presence: 'offline' };
        profile.contacts.push(contact);
      } else if (alias.trim()) contact.alias = alias.trim();
      contactId = contact.id;
    });
    refresh();
    return contactId;
  };

  const addToxFriend = async (accountId: string, address: string, message: string): Promise<string> => {
    const profileId = data.activeProfileId;
    const account = activeProfile(data).accounts.find((item) => item.id === accountId && item.protocol === 'tox');
    if (!account) throw new Error('Tox account was not found');
    const client = await connectTox(account, profileId);
    const friendNumber = await client.addFriend(address, message);
    let contactId = '';
    await vault.update((draft) => {
      const profile = draft.profiles.find((item) => item.id === profileId); if (!profile) return;
      let contact = profile.contacts.find((item) => item.accountId === accountId && item.remoteId === String(friendNumber));
      if (!contact) {
        contact = { id: crypto.randomUUID(), accountId, protocol: 'tox', address: address.slice(0, 64).toUpperCase(), alias: `Tox ${address.slice(0, 8).toUpperCase()}`, presence: 'offline', remoteId: String(friendNumber) };
        profile.contacts.push(contact);
      }
      contactId = contact.id;
    });
    refresh();
    return contactId;
  };

  const acceptToxFriend = async (requestId: string) => {
    const profileId = data.activeProfileId;
    const request = activeProfile(data).friendRequests.find((item) => item.id === requestId);
    const account = activeProfile(data).accounts.find((item) => item.id === request?.accountId && item.protocol === 'tox');
    if (!request || !account) throw new Error('Friend request is no longer available');
    const client = await connectTox(account, profileId);
    const friendNumber = await client.acceptFriend(request.publicKey);
    await vault.update((draft) => {
      const profile = draft.profiles.find((item) => item.id === profileId); if (!profile) return;
      profile.friendRequests = profile.friendRequests.filter((item) => item.id !== requestId);
      profile.contacts.push({ id: crypto.randomUUID(), accountId: account.id, protocol: 'tox', address: request.publicKey, alias: `Tox ${request.publicKey.slice(0, 8)}`, presence: 'offline', remoteId: String(friendNumber) });
    });
    refresh();
  };

  const rejectToxFriend = async (requestId: string) => {
    await vault.update((draft) => { activeProfile(draft).friendRequests = activeProfile(draft).friendRequests.filter((item) => item.id !== requestId); });
    refresh();
  };

  const sendMessage = async (profileId: string, conversation: Conversation, body: string, sourceAccountId: string) => {
    const { profile, account: source } = requireSourceIdentity(data, profileId, conversation, sourceAccountId);
    const contact = profile.contacts.find((item) => item.id === conversation.contactId);
    if (!contact) throw new Error('Contact no longer exists');
    let provider: 'tox' | 'plaintext' | 'omemo' | 'otr' = source.protocol === 'tox' ? 'tox' : 'plaintext';
    if (source.protocol === 'xmpp') {
      try {
        provider = resolveEncryptionProvider(conversation.encryption?.policy ?? profile.settings.defaultEncryptionPolicy, { omemo: false, otr: false }) as 'plaintext' | 'omemo' | 'otr';
      } catch (reason) {
        if (!(reason instanceof PlaintextConfirmationRequired) || !window.confirm(languageHint(t, 'OMEMO/OTR недоступен. Отправить это сообщение через XMPP с защитой только TLS?', 'OMEMO/OTR is unavailable. Send this message over TLS-only XMPP?'))) throw reason;
        provider = 'plaintext';
      }
    }
    const pendingId = `local:${crypto.randomUUID()}`;
    const timestamp = Date.now();
    await vault.update((draft) => {
      const target = draft.profiles.find((item) => item.id === profileId); if (!target) throw new Error('Profile was removed');
      target.messages.push({ id: pendingId, conversationId: conversation.id, direction: 'outgoing', body, timestamp, delivery: 'sending', sourceAccountId, encryptionProvider: provider });
      const current = target.conversations.find((item) => item.id === conversation.id);
      if (current) {
        current.updatedAt = timestamp;
        current.sourceAccountId = sourceAccountId;
        current.encryption = provider === 'tox'
          ? { policy: 'secure-auto', provider: 'tox', verified: true, devices: [] }
          : { policy: current.encryption?.policy ?? target.settings.defaultEncryptionPolicy, provider, verified: false, devices: current.encryption?.devices ?? [], warning: 'tls-only' };
      }
      target.drafts[conversation.id] = '';
    });
    refresh();
    try {
      let sentId: string;
      if (source.protocol === 'tox') {
        const friendNumber = Number(contact.remoteId);
        if (!Number.isInteger(friendNumber) || friendNumber < 0) throw new Error('Tox contact is not linked to a toxcore friend');
        const client = await connectTox(source, profileId);
        const messageId = await client.sendMessage(friendNumber, body);
        sentId = `tox:${sourceAccountId}:${messageId}`;
      } else {
        const client = xmppClients.current.get(`${profileId}:${sourceAccountId}`);
        if (!client) throw new Error(languageHint(t, 'Сначала подключите XMPP-аккаунт.', 'Connect the XMPP account first.'));
        sentId = client.sendMessage(contact.address, body);
      }
      await vault.update((draft) => {
        const message = draft.profiles.find((item) => item.id === profileId)?.messages.find((item) => item.id === pendingId);
        if (message) { message.id = sentId; message.delivery = 'sent'; }
      });
      refresh();
    } catch (reason) {
      await vault.update((draft) => {
        const message = draft.profiles.find((item) => item.id === profileId)?.messages.find((item) => item.id === pendingId);
        if (message) message.delivery = 'failed';
      });
      refresh(); setError(redactError(reason)); throw reason;
    }
  };

  const selectConversation = async (profileId: string, conversationId: string) => {
    if (data.activeProfileId !== profileId) await selectProfile(profileId);
    await vault.update((draft) => { const profile = draft.profiles.find((item) => item.id === profileId); if (profile) { profile.ui.lastConversationId = conversationId; const conversation = profile.conversations.find((item) => item.id === conversationId); if (conversation) conversation.unread = 0; } });
    refresh(); setProfileScope(profileId); setSelectedConversation(conversationId);
  };

  const openContact = async (contactId: string) => {
    const profileId = data.activeProfileId;
    let conversationId = '';
    await vault.update((draft) => {
      const profile = draft.profiles.find((item) => item.id === profileId);
      if (!profile) return;
      const conversation = ensureConversation(profile, contactId);
      conversationId = conversation.id;
      conversation.unread = 0;
      profile.ui.lastConversationId = conversation.id;
    });
    if (!conversationId) throw new Error('Contact is no longer available');
    refresh(); setProfileScope(profileId); setSelectedConversation(conversationId); setScreen('chats');
  };

  const setConversationSource = async (profileId: string, conversationId: string, accountId: string) => {
    await vault.update((draft) => { const profile = draft.profiles.find((item) => item.id === profileId); const conversation = profile?.conversations.find((item) => item.id === conversationId); if (profile && conversation) { conversation.sourceAccountId = accountId; profile.ui.lastChannelByConversation[conversationId] = accountId; } }); refresh();
  };

  const saveDraft = async (profileId: string, conversationId: string, body: string) => {
    await vault.update((draft) => { const profile = draft.profiles.find((item) => item.id === profileId); if (profile) profile.drafts[conversationId] = body; }); refresh();
  };

  const disconnectAccount = async (account: Account) => {
    const key = `${data.activeProfileId}:${account.id}`;
    xmppClients.current.get(key)?.stop(); xmppClients.current.delete(key);
    await toxClients.current.get(key)?.stop(); toxClients.current.delete(key);
    await vault.update((draft) => {
      const current = activeProfile(draft).accounts.find((item) => item.id === account.id);
      if (current) { current.presence = 'offline'; current.connectionState = 'offline'; current.connectionDetail = undefined; }
    });
    refresh();
  };

  const removeAccount = async (account: Account) => {
    await disconnectAccount(account);
    await vault.update((draft) => {
      const profile = activeProfile(draft);
      const contactIds = new Set(profile.contacts.filter((item) => item.accountId === account.id).map((item) => item.id));
      const conversationIds = new Set(profile.conversations.filter((item) => contactIds.has(item.contactId)).map((item) => item.id));
      profile.accounts = profile.accounts.filter((item) => item.id !== account.id);
      profile.contacts = profile.contacts.filter((item) => item.accountId !== account.id);
      profile.friendRequests = profile.friendRequests.filter((item) => item.accountId !== account.id);
      profile.conversations = profile.conversations.filter((item) => !conversationIds.has(item.id));
      profile.messages = profile.messages.filter((item) => !conversationIds.has(item.conversationId));
    });
    refresh();
  };

  const updateSettings = async (next: VaultData['settings']) => {
    await vault.update((draft) => { draft.settings = next; }); refresh();
  };

  return (
    <div className="app-shell">
      <div className="app-grid">
        <aside className="app-sidebar">
          <ProfileRail data={data} scope={profileScope} onAll={() => { setProfileScope('all'); setScreen('chats'); setSelectedConversation(undefined); }} onSelect={(id) => void selectProfile(id)} onCreate={() => void createNewProfile()} onReorder={(draggedId, targetId) => void vault.update((draft) => reorderProfiles(draft, draggedId, targetId)).then(refresh)} onPalette={() => setPaletteOpen(true)}/>
          <Nav screen={screen} setScreen={setScreen} t={t}/>
          <button className="sidebar-lock" onClick={lock} aria-label={t.lock} title={t.lock}><LockIcon/></button>
        </aside>
        <main className="workspace">
          {screen === 'chats' && <Messenger data={data} scope={profileScope} selected={selectedConversation} onBack={() => setSelectedConversation(undefined)} selectConversation={selectConversation} setScreen={setScreen} sendMessage={sendMessage} setSource={setConversationSource} saveDraft={saveDraft} t={t}/>} 
          {screen === 'accounts' && <Accounts profile={currentProfile} addXmpp={addXmpp} connectXmpp={(account) => connectXmpp(account, currentProfile.id)} addTox={addTox} connectTox={(account) => connectTox(account, currentProfile.id)} disconnectAccount={disconnectAccount} removeAccount={removeAccount} t={t}/>} 
          {screen === 'contacts' && <Contacts profile={currentProfile} acceptToxFriend={acceptToxFriend} rejectToxFriend={rejectToxFriend} addXmppContact={addXmppContact} addToxFriend={addToxFriend} openContact={openContact} goToAccounts={() => setScreen('accounts')} t={t}/>} 
          {screen === 'privacy' && <Privacy data={data} profile={currentProfile} network={network} t={t} onLock={lock} onWipe={async () => { await vault.wipe(); setData(undefined); setGate('launch'); }} onExport={async () => downloadText(await vault.exportEncrypted(), 'relayless-vault.rlvault')}/>} 
          {screen === 'plugins' && <Plugins data={data} t={t} onInstall={async (source, granted) => { const manifest = parsePluginManifest(source); await vault.update((draft) => { draft.plugins = installPlugin(manifest, granted, draft.plugins); }); refresh(); }} onToggle={async (id) => { await vault.update((draft) => { const plugin = draft.plugins.find((item) => item.manifest.id === id); if (plugin) plugin.enabled = !plugin.enabled; }); refresh(); }} onRemove={async (id) => { await vault.update((draft) => { draft.plugins = draft.plugins.filter((item) => item.manifest.id !== id); }); refresh(); }}/>} 
          {screen === 'settings' && <Settings data={data} profile={currentProfile} t={t} onSave={updateSettings} onProfileUpdate={async (settings) => { await vault.update((draft) => { const profile = draft.profiles.find((item) => item.id === currentProfile.id); if (profile) profile.settings = settings; }); refresh(); }} onRename={async (name) => { await vault.update((draft) => { const profile = draft.profiles.find((item) => item.id === currentProfile.id); if (profile) { profile.name = name; profile.initials = name.slice(0, 2).toUpperCase(); } }); refresh(); }} onPin={async () => { await vault.update((draft) => { const profile = draft.profiles.find((item) => item.id === currentProfile.id); if (profile) profile.pinned = !profile.pinned; }); refresh(); }} onAvatar={async (avatar) => { await vault.update((draft) => { const profile = draft.profiles.find((item) => item.id === currentProfile.id); if (profile) profile.avatar = avatar; }); refresh(); }} onLockProfile={async () => { for (const account of currentProfile.accounts) { const key = `${currentProfile.id}:${account.id}`; xmppClients.current.get(key)?.stop(); xmppClients.current.delete(key); void toxClients.current.get(key)?.stop(); toxClients.current.delete(key); } await vault.update((draft) => { const profile = draft.profiles.find((item) => item.id === currentProfile.id); if (profile) { profile.locked = true; profile.runtimeState = 'locked'; } }); refresh(); setProfileScope('all'); setSelectedConversation(undefined); setScreen('chats'); }} onDuplicate={async () => { await vault.update((draft) => duplicateProfileSettings(draft, currentProfile.id, `${currentProfile.name} copy`)); refresh(); }} onEphemeral={() => void createNewProfile(true)} onDelete={async () => { for (const account of currentProfile.accounts) { const key = `${currentProfile.id}:${account.id}`; xmppClients.current.get(key)?.stop(); void toxClients.current.get(key)?.stop(); } await vault.update((draft) => deleteProfile(draft, currentProfile.id)); refresh(); }} onExportProfile={async () => downloadText(await vault.exportProfile(currentProfile.id), `${safeFilename(currentProfile.name)}.rlprofile`)} onImportProfile={async (text) => { const id = await vault.importProfile(text); refresh(); await selectProfile(id); }}/>} 
        </main>
      </div>
      <CommandPalette open={paletteOpen} profiles={data.profiles} pluginCommands={availablePluginCommands(data.plugins)} onPluginCommand={(action) => { const screens: Record<typeof action, Screen> = { 'open-chats': 'chats', 'open-accounts': 'accounts', 'open-contacts': 'contacts', 'open-settings': 'settings' }; setScreen(screens[action]); }} onClose={() => setPaletteOpen(false)} onProfile={(id) => void selectProfile(id)} onScope={setProfileScope} onCreate={() => void createNewProfile()}/>
      {error && <div className="error-strip" role="alert"><span>ERR</span>{error}<button onClick={() => setError('')} aria-label="Close">×</button></div>}
    </div>
  );
}

function Nav({ screen, setScreen, t }: { screen: Screen; setScreen: (value: Screen) => void; t: typeof copy[Language] }) {
  const items: Array<[Screen, string, typeof ChatIcon]> = [['chats', t.chats, ChatIcon], ['accounts', t.accounts, AccountsIcon], ['contacts', t.contacts, ContactsIcon], ['privacy', t.privacy, ShieldIcon], ['plugins', languageHint(t, 'Расширения', 'Extensions'), PluginsIcon], ['settings', t.settings, SettingsIcon]];
  return <nav className="rail" aria-label="Primary">{items.map(([id, label, ItemIcon]) => <button key={id} className={screen === id ? 'active' : ''} onClick={() => setScreen(id)} aria-label={label} title={label}><ItemIcon/><span>{label}</span></button>)}</nav>;
}

function FirstLaunch({ language, setLanguage, error, createPersistent, createEphemeral }: { language: Language; setLanguage: (value: Language) => void; error: string; createPersistent: (password: string) => Promise<void>; createEphemeral: () => void }) {
  const [password, setPassword] = useState(''); const t = copy[language];
  const isRu = language === 'ru';
  return <div className="gate-page"><main className="gate-card"><div className="language-switch"><button className={language === 'ru' ? 'active' : ''} onClick={() => setLanguage('ru')}>RU</button><button className={language === 'en' ? 'active' : ''} onClick={() => setLanguage('en')}>EN</button></div><h1>{isRu ? 'Начать пользоваться' : 'Get started'}</h1><p>{isRu ? 'Придумайте пароль. Он защищает ваши чаты на этом устройстве.' : 'Create a password to protect your chats on this device.'}</p><form onSubmit={(event) => { event.preventDefault(); void createPersistent(password); }}><label>{isRu ? 'Пароль' : 'Password'}<input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={10} placeholder="••••••••••••"/></label><span className="field-note">{t.passwordHint}</span><button className="primary" type="submit">{isRu ? 'Продолжить' : 'Continue'}</button></form><div className="gate-divider"><span>{isRu ? 'или' : 'or'}</span></div><button className="text-action" onClick={createEphemeral}>{isRu ? 'Открыть без сохранения' : 'Open without saving'}</button>{error && <div className="inline-error">{error}</div>}</main></div>;
}

function Unlock({ language, setLanguage, error, unlock }: { language: Language; setLanguage: (value: Language) => void; error: string; unlock: (password: string) => Promise<void> }) {
  const [password, setPassword] = useState('');
  const isRu = language === 'ru';
  return <div className="unlock-page"><main className="unlock-box"><div className="language-switch"><button className={language === 'ru' ? 'active' : ''} onClick={() => setLanguage('ru')}>RU</button><button className={language === 'en' ? 'active' : ''} onClick={() => setLanguage('en')}>EN</button></div><div className="unlock-avatar"><LockIcon/></div><h1>{isRu ? 'Введите пароль' : 'Enter password'}</h1><p>{isRu ? 'Чтобы открыть ваши чаты' : 'To open your chats'}</p><form onSubmit={(event) => { event.preventDefault(); void unlock(password); }}><input autoFocus type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="••••••••••••"/><button className="primary" type="submit">{isRu ? 'Открыть' : 'Open'}</button></form>{error && <div className="inline-error">{error}</div>}</main></div>;
}

function Messenger({ data, scope, selected, onBack, selectConversation, setScreen, sendMessage, setSource, saveDraft, t }: { data: VaultData; scope: ProfileScope; selected?: string; onBack: () => void; selectConversation: (profileId: string, conversationId: string) => Promise<void>; setScreen: (screen: Screen) => void; sendMessage: (profileId: string, conversation: Conversation, body: string, sourceAccountId: string) => Promise<void>; setSource: (profileId: string, conversationId: string, accountId: string) => Promise<void>; saveDraft: (profileId: string, conversationId: string, body: string) => Promise<void>; t: typeof copy[Language] }) {
  const [query, setQuery] = useState('');
  const profile = activeProfile(data);
  const rows = useMemo(() => {
    const profiles = scope === 'all' ? data.profiles.filter((item) => !item.locked) : data.profiles.filter((item) => item.id === scope && !item.locked);
    return profiles.flatMap((item) => item.conversations.map((conversation) => ({ profile: item, conversation }))).filter(({ profile: item, conversation }) => conversationMatchesQuery(item, conversation, query)).sort((left, right) => right.conversation.updatedAt - left.conversation.updatedAt);
  }, [data.profiles, query, scope]);
  const current = profile.conversations.find((item) => item.id === selected);
  const messages = current ? profile.messages.filter((item) => item.conversationId === current.id) : [];
  const hasContacts = data.profiles.some((item) => !item.locked && item.contacts.length > 0);
  const newChatScreen: Screen = hasContacts ? 'contacts' : 'accounts';
  const newChatLabel = hasContacts ? languageHint(t, 'Новый чат', 'New chat') : t.connectAccount;
  return <div className="messenger-grid"><section className="conversation-panel"><div className="section-head"><h2>{t.chats}</h2><button className="round-action" onClick={() => setScreen(newChatScreen)} title={newChatLabel} aria-label={newChatLabel}><PlusIcon/></button></div><label className="search"><SearchIcon/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={languageHint(t, 'Поиск по чатам и сообщениям', 'Search chats and messages')}/></label><div className="conversation-list">{rows.map(({ profile: owner, conversation }) => {
    const contact = owner.contacts.find((item) => item.id === conversation.contactId);
    return <button key={`${owner.id}:${conversation.id}`} className={owner.id === profile.id && conversation.id === selected ? 'selected' : ''} onClick={() => void selectConversation(owner.id, conversation.id)}><span className="chat-avatar conversation-avatar">{conversation.title.slice(0, 2).toUpperCase()}<span className={`protocol-mini ${contact?.presence ?? 'offline'}`}>{conversation.protocol === 'tox' ? <ToxIcon/> : <XmppIcon/>}</span></span><span className="conversation-copy"><strong>{conversation.title}</strong><small>{scope === 'all' ? `${owner.name}: ` : ''}{lastMessage(owner.messages, conversation.id)?.body ?? languageHint(t, 'Новый диалог', 'New conversation')}</small></span><span className="conversation-meta"><time>{formatTime(conversation.updatedAt)}</time>{conversation.unread > 0 && <b>{conversation.unread}</b>}</span></button>;
  })}{rows.length === 0 && <EmptyState title={query ? languageHint(t, 'Ничего не найдено', 'Nothing found') : t.noConversations} text={query ? languageHint(t, 'Попробуйте другой запрос.', 'Try another search.') : hasContacts ? languageHint(t, 'Выберите контакт и начните диалог.', 'Choose a contact and start a conversation.') : languageHint(t, 'Подключите аккаунт, чтобы начать общение.', 'Connect an account to start chatting.')} >{!query && <button className="primary compact-action" onClick={() => setScreen(newChatScreen)}>{newChatLabel}</button>}</EmptyState>}</div></section><section className="chat-panel">{current ? <ActiveChat profile={profile} conversation={current} messages={messages} onBack={onBack} send={sendMessage} setSource={setSource} saveDraft={saveDraft} t={t}/> : <div className="chat-idle"><div className="idle-bubble"><ChatIcon/></div><strong>{languageHint(t, 'Выберите чат', 'Choose a chat')}</strong><p>{languageHint(t, 'Здесь появятся сообщения.', 'Messages will appear here.')}</p></div>}</section></div>;
}

function ActiveChat({ profile, conversation, messages, onBack, send, setSource, saveDraft, t }: { profile: LocalProfile; conversation: Conversation; messages: Message[]; onBack: () => void; send: (profileId: string, conversation: Conversation, body: string, sourceAccountId: string) => Promise<void>; setSource: (profileId: string, conversationId: string, accountId: string) => Promise<void>; saveDraft: (profileId: string, conversationId: string, body: string) => Promise<void>; t: typeof copy[Language] }) {
  const [body, setBody] = useState(profile.drafts[conversation.id] ?? '');
  const messagesEnd = useRef<HTMLDivElement>(null);
  useEffect(() => setBody(profile.drafts[conversation.id] ?? ''), [conversation.id, profile.drafts]);
  useEffect(() => messagesEnd.current?.scrollIntoView?.({ block: 'end' }), [conversation.id, messages.length]);
  const identities = profile.accounts.filter((account) => account.protocol === conversation.protocol);
  const sourceId = conversation.sourceAccountId ?? profile.ui.lastChannelByConversation[conversation.id] ?? (identities.length === 1 ? identities[0]?.id : undefined) ?? '';
  const contact = profile.contacts.find((item) => item.id === conversation.contactId);
  const security = encryptionLabel(conversation, t);
  return <><div className="chat-head"><button className="back-button" onClick={onBack} aria-label={languageHint(t, 'Назад', 'Back')}><ArrowIcon/></button><span className="chat-avatar">{conversation.title.slice(0, 2).toUpperCase()}</span><div className="chat-head-copy"><h2>{conversation.title}</h2><small>{presenceLabel(contact?.presence ?? 'offline', t)}</small></div><span className={`security-state ${security.tone}`}>{conversation.protocol === 'tox' ? <ToxIcon/> : <XmppIcon/>}{security.label}</span></div><div className="messages">{messages.length === 0 && <div className="conversation-start"><strong>{conversation.title}</strong><span>{security.label}</span><p>{languageHint(t, 'Напишите первое сообщение.', 'Write the first message.')}</p></div>}{messages.map((message) => <article key={message.id} className={`${message.direction} ${message.delivery === 'failed' ? 'failed' : ''}`}><p>{message.body}<span className="message-meta"><time>{formatTime(message.timestamp)}</time>{message.direction === 'outgoing' && <MessageDelivery state={message.delivery} t={t}/>}</span></p></article>)}<div className="message-anchor" ref={messagesEnd}/></div><form className="composer" onSubmit={(event) => { event.preventDefault(); const value = body.trim(); if (!value || !sourceId) return; setBody(''); void send(profile.id, conversation, value, sourceId).catch(() => setBody(value)); }}>{identities.length > 1 && <select className="identity-selector" aria-label={languageHint(t, 'Отправить от имени', 'Send as')} value={sourceId} onChange={(event) => void setSource(profile.id, conversation.id, event.target.value)} required><option value="" disabled>{languageHint(t, 'Выберите аккаунт', 'Choose account')}</option>{identities.map((identity) => <option key={identity.id} value={identity.id}>{identity.alias}</option>)}</select>}<textarea rows={1} value={body} onChange={(event) => setBody(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} onBlur={() => void saveDraft(profile.id, conversation.id, body)} placeholder={sourceId ? languageHint(t, 'Сообщение', 'Message') : languageHint(t, 'Сначала выберите аккаунт', 'Choose an account first')} maxLength={65536}/><button type="submit" title={t.send} aria-label={t.send} disabled={!sourceId || !body.trim()}><SendIcon/></button></form></>;
}

function Accounts({ profile, addXmpp, connectXmpp, addTox, connectTox, disconnectAccount, removeAccount, t }: { profile: LocalProfile; addXmpp: (account: Account) => Promise<void>; connectXmpp: (account: Account) => void; addTox: (alias: string, savedata?: string) => Promise<void>; connectTox: (account: Account) => Promise<ToxClient>; disconnectAccount: (account: Account) => Promise<void>; removeAccount: (account: Account) => Promise<void>; t: typeof copy[Language] }) {
  const [kind, setKind] = useState<'xmpp' | 'tox'>('xmpp');
  const [toxAlias, setToxAlias] = useState('Tox');
  const [toxImport, setToxImport] = useState('');
  const toxAvailable = hasToxTransport();
  return (
    <div className="content-grid">
      <section>
        <PageTitle index="02" title={t.accounts} subtitle={profile.name}/>
        <div className={`account-list ${profile.accounts.length === 0 ? 'is-empty' : ''}`}>
          {profile.accounts.map((account) => (
            <div className="account-row" key={account.id}>
              <span className={`chat-avatar protocol-account ${account.protocol}`}>{account.protocol === 'xmpp' ? <XmppIcon/> : <ToxIcon/>}</span>
              <div><strong>{account.alias}</strong><small>{account.address}</small>{account.protocol === 'tox' && toxAvailable && <small className="connection-note">{languageHint(t, 'Защищённое подключение через Tox TCP.', 'Secure connection through Tox TCP.')}</small>}</div>
              <span className={`state ${account.protocol === 'tox' && !toxAvailable ? 'error' : account.connectionState ?? account.presence}`} title={account.connectionDetail}>{accountConnectionLabel(account, t)}</span>
              <div className="account-actions">
                {account.address && <button className="icon-text" onClick={() => void navigator.clipboard.writeText(account.address)}>{languageHint(t, 'Копировать', 'Copy')}</button>}
                <button className="secondary compact" disabled={account.protocol === 'tox' && !toxAvailable} title={account.protocol === 'tox' && !toxAvailable ? languageHint(t, 'Шлюз Tox не настроен.', 'The Tox gateway is not configured.') : undefined} onClick={() => accountConnectionRunning(account) ? void disconnectAccount(account) : account.protocol === 'xmpp' ? connectXmpp(account) : void connectTox(account).catch(() => undefined)}>{account.protocol === 'tox' && !toxAvailable ? languageHint(t, 'Нет сети', 'No network') : account.presence === 'online' ? languageHint(t, 'Отключить', 'Disconnect') : accountConnectionRunning(account) ? languageHint(t, 'Отменить', 'Cancel') : account.connectionState === 'error' ? languageHint(t, 'Повторить', 'Retry') : languageHint(t, 'Подключить', 'Connect')}</button>
                <button className="icon-danger" onClick={() => { if (window.confirm(languageHint(t, `Удалить «${account.alias}»?`, `Remove “${account.alias}”?`))) void removeAccount(account); }} aria-label={languageHint(t, 'Удалить аккаунт', 'Remove account')}>×</button>
              </div>
            </div>
          ))}
          {profile.accounts.length === 0 && <EmptyState title={languageHint(t, 'Аккаунтов пока нет', 'No accounts yet')} text={languageHint(t, 'Выберите XMPP или Tox, чтобы начать.', 'Choose XMPP or Tox to get started.')}/>} 
        </div>
      </section>
      <section className="form-panel">
        <h2>{kind === 'xmpp' ? languageHint(t, 'Подключить XMPP', 'Connect XMPP') : languageHint(t, 'Создать Tox-профиль', 'Create Tox profile')}</h2>
        <div className="protocol-picker" role="tablist" aria-label={languageHint(t, 'Протокол', 'Protocol')}>
          <button role="tab" aria-selected={kind === 'xmpp'} className={kind === 'xmpp' ? 'active' : ''} onClick={() => setKind('xmpp')}><span className="protocol-logo xmpp-logo"><XmppIcon/></span><strong>XMPP</strong></button>
          <button role="tab" aria-selected={kind === 'tox'} className={kind === 'tox' ? 'active' : ''} onClick={() => setKind('tox')}><span className="protocol-logo tox-logo"><ToxIcon/></span><strong>Tox</strong></button>
        </div>
        {kind === 'xmpp' ? <XmppAccountSetup addXmpp={addXmpp} t={t}/> : <div className="tox-onboarding">
          <p className="panel-hint">{toxAvailable ? languageHint(t, 'Подключение запустится автоматически.', 'The connection starts automatically.') : languageHint(t, 'Сеть Tox временно недоступна.', 'The Tox network is temporarily unavailable.')}</p><form className="connect-form" onSubmit={(event) => { event.preventDefault(); void addTox(toxAlias, toxImport || undefined).then(() => setToxImport('')); }}>
            <label>{languageHint(t, 'Имя', 'Name')}<input value={toxAlias} onChange={(event) => setToxAlias(event.target.value)} maxLength={128} required/></label>
            <details className="connection-advanced"><summary>{languageHint(t, 'Импорт существующего профиля', 'Import an existing profile')}</summary><label>{languageHint(t, 'Tox savedata в Base64', 'Base64 Tox savedata')}<textarea value={toxImport} onChange={(event) => setToxImport(event.target.value.trim())} rows={3}/></label></details>
            <button className="primary" type="submit">{languageHint(t, 'Создать профиль Tox', 'Create Tox profile')}</button>
          </form>
        </div>}
      </section>
    </div>
  );
}

function Contacts({ profile, acceptToxFriend, rejectToxFriend, addXmppContact, addToxFriend, openContact, goToAccounts, t }: { profile: LocalProfile; acceptToxFriend: (requestId: string) => Promise<void>; rejectToxFriend: (requestId: string) => Promise<void>; addXmppContact: (accountId: string, address: string, alias: string) => Promise<string>; addToxFriend: (accountId: string, address: string, message: string) => Promise<string>; openContact: (contactId: string) => Promise<void>; goToAccounts: () => void; t: typeof copy[Language] }) {
  const xmppAccounts = profile.accounts.filter((item) => item.protocol === 'xmpp');
  const toxAccounts = profile.accounts.filter((item) => item.protocol === 'tox');
  const [kind, setKind] = useState<'xmpp' | 'tox'>(xmppAccounts.length > 0 ? 'xmpp' : 'tox');
  const [accountId, setAccountId] = useState((xmppAccounts[0] ?? toxAccounts[0])?.id ?? '');
  const [address, setAddress] = useState('');
  const [alias, setAlias] = useState('');
  const [message, setMessage] = useState(languageHint(t, 'Привет!', 'Hello!'));
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const accounts = kind === 'xmpp' ? xmppAccounts : toxAccounts;
  const selectedAccountId = accounts.some((item) => item.id === accountId) ? accountId : accounts[0]?.id ?? '';
  const submit = async () => {
    setSubmitting(true); setFormError('');
    try {
      const contactId = kind === 'xmpp'
        ? await addXmppContact(selectedAccountId, address, alias)
        : await addToxFriend(selectedAccountId, address, message);
      setAddress(''); setAlias('');
      await openContact(contactId);
    } catch (reason) { setFormError(redactError(reason)); }
    finally { setSubmitting(false); }
  };
  return <div className="content-grid contacts-grid"><section><PageTitle index="03" title={t.contacts} subtitle={profile.name}/>{profile.friendRequests.length > 0 && <section className="friend-requests"><h2>{languageHint(t, 'Запросы', 'Requests')}</h2>{profile.friendRequests.map((request) => <article key={request.id}><span className="chat-avatar"><ToxIcon/></span><span><strong>Tox {request.publicKey.slice(0, 8)}</strong><small>{request.message || languageHint(t, 'Хочет добавить вас', 'Wants to add you')}</small></span><div className="request-actions"><button className="primary compact" onClick={() => void acceptToxFriend(request.id)}>{languageHint(t, 'Принять', 'Accept')}</button><button className="icon-text" onClick={() => void rejectToxFriend(request.id)}>{languageHint(t, 'Отклонить', 'Decline')}</button></div></article>)}</section>}<div className={`contact-list ${profile.contacts.length === 0 ? 'is-empty' : ''}`}>{profile.contacts.map((contact) => <button className="contact-row" key={contact.id} onClick={() => void openContact(contact.id)}><span className={`chat-avatar ${contact.protocol}`}>{contact.protocol === 'tox' ? <ToxIcon/> : <XmppIcon/>}</span><span><strong>{contact.alias}</strong><small>{contact.address}</small></span><span className="contact-tail"><span className={`presence-dot ${contact.presence}`}/><small>{presenceLabel(contact.presence, t)}</small><ArrowIcon/></span></button>)}{profile.contacts.length === 0 && profile.friendRequests.length === 0 && <EmptyState title={languageHint(t, 'Контактов пока нет', 'No contacts yet')} text={profile.accounts.length > 0 ? languageHint(t, 'Добавьте первый контакт справа.', 'Add your first contact on the right.') : languageHint(t, 'Сначала подключите XMPP или Tox.', 'Connect XMPP or Tox first.')}/>}</div></section><section className="form-panel contact-add-panel"><h2>{languageHint(t, 'Добавить контакт', 'Add contact')}</h2>{profile.accounts.length === 0 ? <EmptyState title={languageHint(t, 'Нет подключений', 'No connections')} text={languageHint(t, 'Добавьте аккаунт, затем возвращайтесь сюда.', 'Add an account, then return here.')}><button className="primary compact-action" onClick={goToAccounts}>{t.connectAccount}</button></EmptyState> : <><div className="protocol-picker" role="tablist" aria-label={languageHint(t, 'Протокол контакта', 'Contact protocol')}><button role="tab" aria-selected={kind === 'xmpp'} disabled={xmppAccounts.length === 0} className={kind === 'xmpp' ? 'active' : ''} onClick={() => { setKind('xmpp'); setAccountId(xmppAccounts[0]?.id ?? ''); setAddress(''); setFormError(''); }}><span className="protocol-logo xmpp-logo"><XmppIcon/></span><strong>XMPP</strong></button><button role="tab" aria-selected={kind === 'tox'} disabled={toxAccounts.length === 0} className={kind === 'tox' ? 'active' : ''} onClick={() => { setKind('tox'); setAccountId(toxAccounts[0]?.id ?? ''); setAddress(''); setFormError(''); }}><span className="protocol-logo tox-logo"><ToxIcon/></span><strong>Tox</strong></button></div><form className="connect-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}><label>{languageHint(t, 'Ваш аккаунт', 'Your account')}<select value={selectedAccountId} onChange={(event) => setAccountId(event.target.value)} required>{accounts.map((account) => <option key={account.id} value={account.id}>{account.alias}{account.presence === 'online' ? ` · ${languageHint(t, 'в сети', 'online')}` : ''}</option>)}</select></label><label>{kind === 'xmpp' ? languageHint(t, 'Адрес XMPP', 'XMPP address') : 'Tox ID'}<input type={kind === 'xmpp' ? 'email' : 'text'} value={address} onChange={(event) => setAddress(event.target.value.trim())} placeholder={kind === 'xmpp' ? 'friend@example.org' : undefined} minLength={kind === 'tox' ? 76 : undefined} maxLength={kind === 'tox' ? 76 : 320} spellCheck={false} required/></label>{kind === 'xmpp' ? <label>{languageHint(t, 'Имя в приложении', 'Name in the app')}<input value={alias} onChange={(event) => setAlias(event.target.value)} maxLength={128} placeholder={languageHint(t, 'Необязательно', 'Optional')}/></label> : <label>{languageHint(t, 'Сообщение-знакомство', 'Introduction message')}<input value={message} onChange={(event) => setMessage(event.target.value)} maxLength={500}/></label>}<button className="primary" type="submit" disabled={submitting || !selectedAccountId}>{submitting ? languageHint(t, 'Добавляем…', 'Adding…') : kind === 'xmpp' ? languageHint(t, 'Добавить и открыть чат', 'Add and open chat') : languageHint(t, 'Отправить запрос', 'Send request')}</button>{formError && <p className="inline-error" role="alert">{formError}</p>}</form></>}</section></div>;
}

function Privacy({ data, profile, network, t, onLock, onWipe, onExport }: { data: VaultData; profile: LocalProfile; network: NetworkActivity[]; t: typeof copy[Language]; onLock: () => void; onWipe: () => Promise<void>; onExport: () => Promise<void> }) {
  const messageCount = data.profiles.reduce((count, item) => count + item.messages.length, 0);
  return <div className="single-page privacy-page"><PageTitle index="04" title={t.privacy} subtitle={profile.name}/><section className="summary-list"><div><span>{languageHint(t, 'Сообщения на устройстве', 'Messages on device')}</span><strong>{messageCount}</strong></div><div><span>{t.currentConnections}</span><strong>{network.filter((item) => item.state === 'open').length}</strong></div></section><p className="simple-notice">{languageHint(t, 'Данные хранятся только на этом устройстве. Вы можете заблокировать приложение или скачать резервную копию.', 'Data stays on this device. You can lock the app or download a backup.')}</p><section className="vault-actions"><button onClick={() => void onExport()}><DownloadIcon/><span><strong>{languageHint(t, 'Скачать резервную копию', 'Download backup')}</strong><small>{languageHint(t, 'Копия защищена вашим паролем', 'Protected with your password')}</small></span><ArrowIcon/></button><button onClick={onLock}><LockIcon/><span><strong>{t.lock}</strong><small>{languageHint(t, 'Потребуется снова ввести пароль', 'You will need to enter your password again')}</small></span><ArrowIcon/></button><button className="danger" onClick={() => { if (window.confirm(t.dangerWipe)) void onWipe(); }}><span className="delete-x">×</span><span><strong>{t.wipe}</strong><small>{t.dangerWipe}</small></span><ArrowIcon/></button></section></div>;
}

function Plugins({ data, t, onInstall, onToggle, onRemove }: { data: VaultData; t: typeof copy[Language]; onInstall: (source: string, granted: PluginPermission[]) => Promise<void>; onToggle: (id: string) => Promise<void>; onRemove: (id: string) => Promise<void> }) {
  const [pending, setPending] = useState<{ source: string; name: string; description: string; permissions: PluginPermission[] }>();
  const [granted, setGranted] = useState<PluginPermission[]>([]);
  const [pluginError, setPluginError] = useState('');
  const choose = async (file?: File) => {
    if (!file) return;
    try {
      const source = await file.text();
      const manifest = parsePluginManifest(source);
      setPending({ source, name: manifest.name, description: manifest.description, permissions: manifest.permissions });
      setGranted([]); setPluginError('');
    } catch (reason) { setPluginError(redactError(reason)); setPending(undefined); }
  };
  return <div className="single-page plugins-page"><PageTitle index="06" title={languageHint(t, 'Расширения', 'Extensions')} subtitle=""/><p className="page-description">{languageHint(t, 'Расширения добавляют команды, но не получают доступ к паролям и ключам. Каждое разрешение подтверждается отдельно.', 'Extensions add commands but never receive passwords or keys. Every permission is granted separately.')}</p><section className={`plugin-list ${data.plugins.length === 0 ? 'is-empty' : ''}`}>{data.plugins.map((plugin) => <article key={plugin.manifest.id}><span className="plugin-avatar"><PluginsIcon/></span><div><strong>{plugin.manifest.name}</strong><small>{plugin.manifest.description || plugin.manifest.id}</small><em>v{plugin.manifest.version}</em></div><Toggle checked={plugin.enabled} onChange={() => void onToggle(plugin.manifest.id)}/><button className="icon-danger" onClick={() => void onRemove(plugin.manifest.id)} aria-label={languageHint(t, 'Удалить расширение', 'Remove extension')}>×</button></article>)}{data.plugins.length === 0 && <EmptyState title={languageHint(t, 'Расширений пока нет', 'No extensions yet')} text={languageHint(t, 'Установите локальный файл манифеста.', 'Install a local manifest file.')}/>}</section><section className="plugin-installer"><h2>{languageHint(t, 'Установить расширение', 'Install extension')}</h2><label className="secondary file-action">{languageHint(t, 'Выбрать файл .rlplugin.json', 'Choose .rlplugin.json file')}<input type="file" accept=".json,.rlplugin.json,application/json" onChange={(event) => void choose(event.target.files?.[0])}/></label>{pending && <div className="plugin-review"><strong>{pending.name}</strong><p>{pending.description}</p>{pending.permissions.length > 0 && <><small>{languageHint(t, 'Разрешения', 'Permissions')}</small>{pending.permissions.map((permission) => <label className="permission-row" key={permission}><input type="checkbox" checked={granted.includes(permission)} onChange={(event) => setGranted((current) => event.target.checked ? [...current, permission] : current.filter((item) => item !== permission))}/><span>{pluginPermissionLabel(permission, t)}</span></label>)}</>}<button className="primary" onClick={() => void onInstall(pending.source, granted).then(() => { setPending(undefined); setGranted([]); }).catch((reason) => setPluginError(redactError(reason)))}>{languageHint(t, 'Установить', 'Install')}</button></div>}{pluginError && <p className="inline-error">{pluginError}</p>}</section></div>;
}

function Settings({ data, profile, t, onSave, onProfileUpdate, onRename, onPin, onAvatar, onLockProfile, onDuplicate, onEphemeral, onDelete, onExportProfile, onImportProfile }: { data: VaultData; profile: LocalProfile; t: typeof copy[Language]; onSave: (settings: VaultData['settings']) => Promise<void>; onProfileUpdate: (settings: ProfileSettings) => Promise<void>; onRename: (name: string) => Promise<void>; onPin: () => Promise<void>; onAvatar: (avatar: string) => Promise<void>; onLockProfile: () => Promise<void>; onDuplicate: () => Promise<void>; onEphemeral: () => void; onDelete: () => Promise<void>; onExportProfile: () => Promise<void>; onImportProfile: (text: string) => Promise<void> }) {
  const [settings, setSettings] = useState(data.settings);
  const [profileSettings, setProfileSettings] = useState(profile.settings);
  const [name, setName] = useState(profile.name);
  useEffect(() => { setProfileSettings(profile.settings); setName(profile.name); }, [profile.id, profile.name, profile.settings]);
  const importProfile = async (file?: File) => { if (file) await onImportProfile(await file.text()); };
  const setAvatar = (file?: File) => { if (!file) return; if (!file.type.startsWith('image/') || file.size > 512_000) { window.alert('Use a local image smaller than 500 KiB'); return; } const reader = new FileReader(); reader.onload = () => { if (typeof reader.result === 'string') void onAvatar(reader.result); }; reader.readAsDataURL(file); };
  return <div className="single-page settings-page"><PageTitle index="05" title={t.settings} subtitle={profile.name}/><section className="settings-section"><div className="profile-editor"><label className="avatar-editor"><span className="profile-avatar large">{profile.avatar ? <img src={profile.avatar} alt=""/> : <UserIcon/>}</span><input type="file" accept="image/*" onChange={(event) => setAvatar(event.target.files?.[0])}/><small>{languageHint(t, 'Изменить фото', 'Change photo')}</small></label><label>{languageHint(t, 'Имя профиля', 'Profile name')}<input value={name} onChange={(event) => setName(event.target.value)}/></label></div><SettingRow label={t.language}><div className="segmented"><button className={settings.language === 'ru' ? 'active' : ''} onClick={() => setSettings({ ...settings, language: 'ru' })}>Русский</button><button className={settings.language === 'en' ? 'active' : ''} onClick={() => setSettings({ ...settings, language: 'en' })}>English</button></div></SettingRow><SettingRow label={t.autoLock}><select value={settings.autoLockMinutes} onChange={(event) => setSettings({ ...settings, autoLockMinutes: Number(event.target.value) })}>{[5, 15, 30, 60].map((minutes) => <option key={minutes} value={minutes}>{minutes} {t.minutes}</option>)}</select></SettingRow><SettingRow label={t.history}><Toggle checked={settings.retainHistory} onChange={(checked) => setSettings({ ...settings, retainHistory: checked })}/></SettingRow><SettingRow label={t.notifications}><button className="secondary compact" onClick={() => void requestLocalNotifications()}>{languageHint(t, 'Включить', 'Enable')}</button></SettingRow><SettingRow label={t.previews}><Toggle checked={settings.showNotificationPreviews} onChange={(checked) => setSettings({ ...settings, showNotificationPreviews: checked })}/></SettingRow></section><details className="advanced-settings"><summary>{languageHint(t, 'Дополнительно', 'Advanced')}</summary><section className="settings-section"><SettingRow label={languageHint(t, 'Когда профиль не активен', 'When profile is inactive')}><select value={profileSettings.connectionPolicy} onChange={(event) => setProfileSettings({ ...profileSettings, connectionPolicy: event.target.value as ProfileSettings['connectionPolicy'] })}><option value="background">{languageHint(t, 'Оставаться на связи', 'Stay connected')}</option><option value="sleep">{languageHint(t, 'Приостановить', 'Pause')}</option><option value="disconnect">{languageHint(t, 'Отключить', 'Disconnect')}</option></select></SettingRow><SettingRow label={languageHint(t, 'Шифрование', 'Encryption')}><select value={profileSettings.defaultEncryptionPolicy} onChange={(event) => setProfileSettings({ ...profileSettings, defaultEncryptionPolicy: event.target.value as ProfileSettings['defaultEncryptionPolicy'] })}><option value="secure-auto">{languageHint(t, 'Автоматически', 'Automatic')}</option><option value="force-omemo">OMEMO</option><option value="force-otr">OTR</option><option value="plaintext">{languageHint(t, 'Обычные сообщения', 'Standard messages')}</option></select></SettingRow><SettingRow label={t.debug}><Toggle checked={settings.debugEnabled} onChange={(checked) => setSettings({ ...settings, debugEnabled: checked })}/></SettingRow><div className="profile-action-grid"><button className="secondary" onClick={() => void onPin()}>{profile.pinned ? languageHint(t, 'Открепить профиль', 'Unpin profile') : languageHint(t, 'Закрепить профиль', 'Pin profile')}</button><button className="secondary" onClick={() => void onDuplicate()}>{languageHint(t, 'Создать копию настроек', 'Duplicate settings')}</button><button className="secondary" onClick={onEphemeral}>{languageHint(t, 'Временный профиль', 'Temporary profile')}</button><button className="secondary" onClick={() => void onExportProfile()}>{languageHint(t, 'Экспорт профиля', 'Export profile')}</button><label className="secondary file-action">{languageHint(t, 'Импорт профиля', 'Import profile')}<input type="file" accept=".rlprofile,application/json" onChange={(event) => void importProfile(event.target.files?.[0])}/></label><button className="secondary" onClick={() => void onLockProfile()}>{languageHint(t, 'Заблокировать профиль', 'Lock profile')}</button><button className="secondary danger-outline" disabled={data.profiles.length === 1} onClick={() => { if (window.confirm(languageHint(t, `Удалить профиль «${profile.name}» и все его данные?`, `Delete profile “${profile.name}” and all its data?`))) void onDelete(); }}>{languageHint(t, 'Удалить профиль', 'Delete profile')}</button></div></section></details><button className="primary save-button" onClick={() => { void onSave(settings); void onProfileUpdate(profileSettings); if (name.trim() && name !== profile.name) void onRename(name); }}>{languageHint(t, 'Сохранить изменения', 'Save changes')}</button></div>;
}

function SettingRow({ label, note, children }: { label: string; note?: string; children: ReactNode }) { return <div className="setting-row"><div><strong>{label}</strong>{note && <small>{note}</small>}</div>{children}</div>; }
function Toggle({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) { return <button className={`toggle ${checked ? 'on' : ''}`} role="switch" aria-checked={checked} onClick={() => onChange(!checked)}><span/></button>; }
function PageTitle({ title }: { index: string; title: string; subtitle: string }) { return <div className="page-title"><h1>{title}</h1></div>; }
function EmptyState({ title, text, children }: { title: string; text: string; children?: ReactNode }) { return <div className="empty-state"><strong>{title}</strong><p>{text}</p>{children}</div>; }
function MessageDelivery({ state, t }: { state: Message['delivery']; t: typeof copy[Language] }) {
  const labels: Record<Message['delivery'], [string, string]> = {
    sending: ['Отправляется', 'Sending'], sent: ['Отправлено', 'Sent'], delivered: ['Доставлено', 'Delivered'], failed: ['Не отправлено', 'Failed'],
  };
  const Icon = state === 'sending' ? PendingIcon : state === 'sent' ? SentIcon : state === 'delivered' ? DeliveredIcon : FailedIcon;
  return <span className={`delivery-mark ${state}`} aria-label={languageHint(t, ...labels[state])} title={languageHint(t, ...labels[state])}><Icon/></span>;
}
function presenceLabel(presence: LocalProfile['contacts'][number]['presence'], t: typeof copy[Language]): string {
  const labels = {
    online: ['В сети', 'Online'], away: ['Отошёл', 'Away'], busy: ['Не беспокоить', 'Busy'], offline: ['Не в сети', 'Offline'],
  } as const;
  const [ru, en] = labels[presence];
  return languageHint(t, ru, en);
}
function encryptionLabel(conversation: Conversation, t: typeof copy[Language]): { label: string; tone: 'secure' | 'warning' } {
  if (conversation.protocol === 'tox') return { label: languageHint(t, 'Tox · сквозное шифрование', 'Tox · end-to-end encrypted'), tone: 'secure' };
  if (conversation.encryption?.provider === 'omemo') return { label: `OMEMO · ${conversation.encryption.verified ? languageHint(t, 'проверено', 'verified') : languageHint(t, 'не проверено', 'unverified')}`, tone: conversation.encryption.verified ? 'secure' : 'warning' };
  if (conversation.encryption?.provider === 'otr') return { label: `OTR · ${conversation.encryption.verified ? languageHint(t, 'проверено', 'verified') : languageHint(t, 'не проверено', 'unverified')}`, tone: conversation.encryption.verified ? 'secure' : 'warning' };
  return { label: languageHint(t, 'XMPP · защита TLS', 'XMPP · TLS transport'), tone: 'warning' };
}
function accountConnectionRunning(account: Account): boolean {
  return ['starting', 'connecting', 'authenticating', 'online', 'reconnecting'].includes(account.connectionState ?? account.presence);
}
function accountConnectionLabel(account: Account, t: typeof copy[Language]): string {
  if (account.protocol === 'tox' && !hasToxTransport()) return languageHint(t, 'Нет сети', 'No network');
  const state = account.connectionState ?? account.presence;
  const labels: Record<string, [string, string]> = {
    offline: ['Не подключён', 'Offline'], starting: ['Запускается…', 'Starting…'], connecting: ['Подключение…', 'Connecting…'], authenticating: ['Вход…', 'Signing in…'], online: ['В сети', 'Online'], reconnecting: ['Переподключение…', 'Reconnecting…'], error: ['Ошибка подключения', 'Connection error'],
  };
  const [ru, en] = labels[state] ?? labels.offline!;
  return languageHint(t, ru, en);
}
function languageHint(t: typeof copy[Language], ru: string, en: string) { return t === copy.ru ? ru : en; }
function pluginPermissionLabel(permission: PluginPermission, t: typeof copy[Language]) {
  const labels: Record<PluginPermission, [string, string]> = {
    commands: ['Добавлять команды', 'Add commands'],
    'message-metadata': ['Читать служебные данные сообщений', 'Read message metadata'],
    'contacts-summary': ['Читать список имён контактов', 'Read contact names'],
  };
  const [ru, en] = labels[permission]; return languageHint(t, ru, en);
}
function lastMessage(messages: Message[], conversationId: string) { return messages.filter((item) => item.conversationId === conversationId).at(-1); }
function formatTime(timestamp: number) { return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(timestamp); }
function downloadText(value: string, filename: string) { const url = URL.createObjectURL(new Blob([value], { type: 'application/json' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url); }
function safeFilename(value: string) { return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'profile'; }
