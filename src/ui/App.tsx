import { Component, useCallback, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import { activeProfile, createProfile, deleteProfile, duplicateProfileSettings, reorderProfiles } from '../models/profiles';
import { conversationMatchesQuery, ensureConversation, recordIncomingActivity } from '../models/conversations';
import { requireSourceIdentity, switchProfileState } from '../models/profileRuntime';
import { reconcileToxFriends, resolveToxContact } from '../models/toxIdentity';
import type { Account, Contact, Conversation, LocalProfile, Message, PluginPermission, ProfileSettings, VaultData } from '../models/types';
import { networkPolicy, type NetworkActivity } from '../network/policy';
import { XmppClient } from '../protocols/xmpp/client';
import { ToxClient } from '../protocols/tox/client';
import { hasToxTransport } from '../protocols/tox/gatewayConfig';
import type { ToxEvent } from '../protocols/tox/types';
import { availablePluginCommands, installPlugin, parsePluginManifest } from '../plugins/host';
import { redactError } from '../security/redaction';
import { Vault } from '../security/vault';
import { copy, type Language } from './i18n';
import { AccountsIcon, ArrowIcon, CancelIcon, ChatIcon, ContactsIcon, DeliveredIcon, DownloadIcon, EditIcon, FailedIcon, LockIcon, PendingIcon, PluginsIcon, PlusIcon, SearchIcon, SendIcon, SentIcon, SettingsIcon, ShieldIcon, ToxIcon, UserIcon, XmppIcon } from './icons';
import { CommandPalette } from './CommandPalette';
import { ContextMenu, useContextMenu } from './ContextMenu';
import { ProfileRail, type ProfileScope } from './ProfileRail';
import { PlaintextConfirmationRequired, resolveEncryptionProvider } from '../encryption/provider';
import { requestLocalNotifications, showLocalMessageNotification } from './notifications';
import { XmppAccountSetup } from './XmppAccountSetup';
import type { OmemoEngine } from '../encryption/omemo';
import { OtrManager, type OtrEvent } from '../encryption/otr';

type Screen = 'chats' | 'accounts' | 'contacts' | 'privacy' | 'plugins' | 'settings';
type Gate = 'loading' | 'launch' | 'unlock' | 'open';

const vault = new Vault();
const TOX_MESSAGE_MAX_BYTES = 1372;
const XMPP_MESSAGE_MAX_BYTES = 64 * 1024;
const MESSAGE_RENDER_BATCH = 200;
const MAX_PROFILE_BACKUP_BYTES = 64 * 1024 * 1024;
const MAX_PLUGIN_MANIFEST_BYTES = 64 * 1024;

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
  const omemoEngines = useRef(new Map<string, OmemoEngine>());
  const omemoInitializations = useRef(new Map<string, Promise<OmemoEngine>>());
  const otrManagers = useRef(new Map<string, OtrManager>());
  const otrInitializations = useRef(new Map<string, Promise<OtrManager>>());
  const toxClients = useRef(new Map<string, ToxClient>());
  const toxSavedata = useRef(new Map<string, string>());
  const viewState = useRef<{ activeProfileId?: string; screen: Screen; conversationId?: string }>({ screen: 'chats' });
  const t = copy[language];

  useEffect(() => { viewState.current = { activeProfileId: data?.activeProfileId, screen, conversationId: selectedConversation }; }, [data?.activeProfileId, screen, selectedConversation]);

  useEffect(() => {
    void (async () => {
      try {
        const exists = await vault.exists();
        if (!exists) { setGate('launch'); return; }
        if (await vault.tryDeviceUnlock()) { refresh(); setGate('open'); void requestDurableStorage(); return; }
        setGate('unlock');
      } catch (reason) {
        setError(redactError(reason)); setGate('launch');
      }
    })();
    return networkPolicy.subscribe(setNetwork);
  }, []);

  useEffect(() => () => {
    for (const client of xmppClients.current.values()) client.stop();
    omemoEngines.current.clear(); omemoInitializations.current.clear();
    for (const manager of otrManagers.current.values()) manager.close();
    otrManagers.current.clear(); otrInitializations.current.clear();
    for (const client of toxClients.current.values()) void client.stop();
  }, []);

  useEffect(() => {
    if (!data) return;
    const allowedProfiles = new Set(data.profiles.filter((profile) => !profile.locked).map((profile) => profile.id));
    for (const [key, manager] of otrManagers.current) {
      const profileId = key.split(':', 1)[0];
      if (profileId && allowedProfiles.has(profileId)) continue;
      manager.close();
      otrManagers.current.delete(key);
      otrInitializations.current.delete(key);
    }
  }, [data]);

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
    let timer = window.setTimeout(() => void lock(), data.settings.autoLockMinutes * 60_000);
    const arm = () => { window.clearTimeout(timer); timer = window.setTimeout(() => void lock(), data.settings.autoLockMinutes * 60_000); };
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

  const createPersistent = async (password: string, rememberDevice: boolean) => {
    setError('');
    try { await vault.create(password, language); if (rememberDevice) await vault.enableDeviceUnlock(password); refresh(); setGate('open'); void requestDurableStorage(); }
    catch (reason) { setError(redactError(reason)); }
  };

  const createEphemeral = () => { vault.createEphemeral(language); refresh(); setGate('open'); };

  const unlock = async (password: string, rememberDevice: boolean) => {
    setError('');
    try { await vault.unlock(password); if (rememberDevice) await vault.enableDeviceUnlock(password); else await vault.disableDeviceUnlock(); refresh(); setGate('open'); void requestDurableStorage(); }
    catch (reason) { setError(redactError(reason)); }
  };

  async function lock() {
    for (const client of xmppClients.current.values()) client.stop();
    for (const client of toxClients.current.values()) void client.stop();
    xmppClients.current.clear(); omemoEngines.current.clear(); omemoInitializations.current.clear(); toxClients.current.clear();
    for (const manager of otrManagers.current.values()) manager.close();
    otrManagers.current.clear(); otrInitializations.current.clear();
    await vault.disableDeviceUnlock().catch(() => undefined);
    vault.lock(); setData(undefined); setGate('unlock');
  }

  if (gate === 'loading') return <div className="boot"/>;
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
      xmppClients.current.get(key)?.stop(); xmppClients.current.delete(key); omemoEngines.current.delete(key); omemoInitializations.current.delete(key);
      otrManagers.current.get(key)?.close(); otrManagers.current.delete(key); otrInitializations.current.delete(key);
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
    if (existing) {
      existing.stop(); xmppClients.current.delete(key); omemoEngines.current.delete(key); omemoInitializations.current.delete(key);
      otrManagers.current.get(key)?.reset();
    }
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
        }).then(() => {
          refresh();
          if (event.state === 'online') {
            void initializeOmemo(client, account, profileId).catch((reason) => setError(redactError(reason)));
          } else if (event.state === 'offline' || event.state === 'error') {
            otrManagers.current.get(key)?.reset();
          }
        });
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
          if (contact) {
            contact.presence = event.show === 'offline' ? 'offline' : event.show === 'away' || event.show === 'xa' ? 'away' : event.show === 'dnd' ? 'busy' : 'online';
            if (event.show !== 'offline' && event.peer.includes('/')) contact.resource = event.peer;
            if (event.show === 'offline' && contact.resource === event.peer) contact.resource = undefined;
          }
        }).then(refresh);
      }
      if (event.type === 'otr-wire') {
        void initializeOtr(client, account, profileId)
          .then((manager) => manager.receive(event.peer, event.body, event.id, event.timestamp))
          .catch((reason) => setError(redactError(reason)));
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
          if (event.peer.includes('/')) contact.resource = event.peer;
          let conversation = profile.conversations.find((item) => item.contactId === contact.id);
          if (!conversation) {
            conversation = { id: crypto.randomUUID(), contactId: contact.id, protocol: 'xmpp', title: contact.alias, unread: 0, updatedAt: event.timestamp, sourceAccountId: account.id, encryption: { policy: profile.settings.defaultEncryptionPolicy, provider: 'plaintext', verified: false, devices: [], warning: 'tls-only' } };
            profile.conversations.push(conversation);
          }
          const visible = viewState.current.activeProfileId === profileId && viewState.current.screen === 'chats' && viewState.current.conversationId === conversation.id;
          if (event.direction === 'incoming') recordIncomingActivity(conversation, visible, event.timestamp);
          else conversation.updatedAt = Math.max(conversation.updatedAt, event.timestamp);
          conversationTitle = conversation.title; shouldNotify = event.direction === 'incoming' && !visible;
          profile.messages.push({ id: event.id, conversationId: conversation.id, direction: event.direction, body: event.body, timestamp: event.timestamp, delivery: 'delivered', sourceAccountId: account.id, encryptionProvider: 'plaintext' });
        }).then(() => { refresh(); if (shouldNotify) showLocalMessageNotification(profileName, conversationTitle, event.body, vault.snapshot.settings.showNotificationPreviews); });
      }
      if (event.type === 'encrypted-message') {
        void (async () => {
          try {
            const engine = omemoEngines.current.get(key) ?? await initializeOmemo(client, account, profileId);
            const decrypted = await engine.decrypt(event.from, event.payload);
            const profileName = vault.snapshot.profiles.find((item) => item.id === profileId)?.name ?? 'Relayless';
            let shouldNotify = false;
            let conversationTitle = event.from;
            await vault.update((draft) => {
              const profile = draft.profiles.find((item) => item.id === profileId); if (!profile) return;
              if (profile.messages.some((item) => item.id === event.id)) return;
              let contact = profile.contacts.find((item) => item.accountId === account.id && item.address === event.from);
              if (!contact) {
                contact = { id: crypto.randomUUID(), accountId: account.id, protocol: 'xmpp', address: event.from, alias: event.from, presence: 'offline' };
                profile.contacts.push(contact);
              }
              let conversation = profile.conversations.find((item) => item.contactId === contact.id);
              const remoteDeviceId = String(event.payload.senderDeviceId);
              const deviceId = `${event.from}:${remoteDeviceId}`;
              const device = { id: deviceId, label: `XMPP ${remoteDeviceId}`, fingerprint: decrypted.fingerprint, trust: 'untrusted' as const, firstSeenAt: Date.now() };
              if (!conversation) {
                conversation = { id: crypto.randomUUID(), contactId: contact.id, protocol: 'xmpp', title: contact.alias, unread: 0, updatedAt: event.timestamp, sourceAccountId: account.id, encryption: { policy: 'secure-auto', provider: 'omemo', verified: false, devices: [device], warning: 'first-use' } };
                profile.conversations.push(conversation);
              } else {
                const existingDevice = conversation.encryption?.devices.find((item) => item.id === deviceId);
                const changed = Boolean(existingDevice && existingDevice.fingerprint !== decrypted.fingerprint);
                conversation.encryption = {
                  policy: conversation.encryption?.policy ?? 'secure-auto', provider: 'omemo',
                  verified: Boolean(existingDevice?.trust === 'trusted' && !changed),
                  devices: changed
                    ? [...(conversation.encryption?.devices.filter((item) => item.id !== deviceId) ?? []), { ...device, changedAt: Date.now() }]
                    : existingDevice ? conversation.encryption!.devices : [...(conversation.encryption?.devices ?? []), device],
                  warning: changed ? 'changed-device' : existingDevice?.trust === 'trusted' ? undefined : 'first-use',
                };
              }
              const visible = viewState.current.activeProfileId === profileId && viewState.current.screen === 'chats' && viewState.current.conversationId === conversation.id;
              recordIncomingActivity(conversation, visible, event.timestamp);
              conversationTitle = conversation.title; shouldNotify = !visible;
              profile.messages.push({ id: event.id, conversationId: conversation.id, direction: 'incoming', body: decrypted.body, timestamp: event.timestamp, delivery: 'delivered', sourceAccountId: account.id, encryptionProvider: 'omemo' });
            });
            refresh();
            if (shouldNotify) showLocalMessageNotification(profileName, conversationTitle, decrypted.body, vault.snapshot.settings.showNotificationPreviews);
          } catch (reason) { setError(redactError(reason)); }
        })();
      }
      if (event.type === 'receipt') {
        void vault.update((draft) => { const message = draft.profiles.find((profile) => profile.id === profileId)?.messages.find((item) => item.id === event.id); if (message) message.delivery = 'delivered'; }).then(refresh);
      }
      if (event.type === 'message-error') {
        void vault.update((draft) => { const message = draft.profiles.find((profile) => profile.id === profileId)?.messages.find((item) => item.id === event.id); if (message) message.delivery = 'failed'; }).then(refresh);
        setError(event.detail);
      }
      if (event.type === 'omemo-devices') {
        omemoEngines.current.get(key)?.updateDeviceList(event.from, event.deviceIds, event.namespace);
      }
    });
    xmppClients.current.set(key, client);
    void client.start({ jid: account.address, password: account.secret, endpoint: account.endpoint, restoreArchive: account.mamEnabled }).catch((reason) => setError(redactError(reason)));
  };

  const initializeOmemo = async (client: XmppClient, account: Account, profileId: string): Promise<OmemoEngine> => {
    const key = `${profileId}:${account.id}`;
    const existing = omemoEngines.current.get(key);
    if (existing) {
      // A second client can overwrite a PEP device list while this browser is
      // disconnected. Re-announce both modern and Dino-compatible legacy
      // bundles after every successful stream recovery.
      await existing.announce();
      return existing;
    }
    const pending = omemoInitializations.current.get(key);
    if (pending) return pending;
    const initialization = (async () => {
      const saved = vault.snapshot.profiles.find((item) => item.id === profileId)?.omemoAccounts[account.id];
      const { OmemoEngine: Engine } = await import('../encryption/omemo');
      const engine = await Engine.open(client, account.address, saved, async (state) => {
        await vault.update((draft) => {
          const profile = draft.profiles.find((item) => item.id === profileId);
          if (profile) profile.omemoAccounts[account.id] = state;
        });
      });
      omemoEngines.current.set(key, engine);
      try { await engine.announce(); }
      catch (reason) {
        omemoEngines.current.delete(key);
        client.setOmemoDeviceId(undefined);
        throw new Error(`OMEMO could not be enabled: ${redactError(reason)}`, { cause: reason });
      }
      return engine;
    })();
    omemoInitializations.current.set(key, initialization);
    try { return await initialization; }
    finally {
      if (omemoInitializations.current.get(key) === initialization) omemoInitializations.current.delete(key);
    }
  };

  const initializeOtr = async (client: XmppClient, account: Account, profileId: string): Promise<OtrManager> => {
    const key = `${profileId}:${account.id}`;
    const existing = otrManagers.current.get(key);
    if (existing) return existing;
    const pending = otrInitializations.current.get(key);
    if (pending) return pending;
    const initialization = OtrManager.open(
      vault.snapshot.profiles.find((item) => item.id === profileId)?.otrAccounts[account.id],
      async (state) => {
        await vault.update((draft) => {
          const profile = draft.profiles.find((item) => item.id === profileId);
          if (profile) profile.otrAccounts[account.id] = state;
        });
      },
    ).then((manager) => {
      manager.subscribe((event) => handleOtrEvent(client, account, profileId, manager, event));
      otrManagers.current.set(key, manager);
      return manager;
    });
    otrInitializations.current.set(key, initialization);
    try { return await initialization; }
    finally {
      if (otrInitializations.current.get(key) === initialization) otrInitializations.current.delete(key);
    }
  };

  const handleOtrEvent = (client: XmppClient, account: Account, profileId: string, manager: OtrManager, event: OtrEvent) => {
    if (event.type === 'error') {
      if (event.severity === 'error') setError(`OTR: ${event.message}`);
      return;
    }
    if (event.type === 'wire') {
      try {
        const stanzaId = client.sendOtrMessage(event.peer, event.body, Boolean(event.localId));
        if (event.localId) {
          void vault.update((draft) => {
            const message = draft.profiles.find((item) => item.id === profileId)?.messages.find((item) => item.id === event.localId);
            if (message) { message.id = stanzaId; message.delivery = 'sent'; }
          }).then(refresh);
        }
      } catch (reason) {
        if (event.localId) {
          void vault.update((draft) => {
            const message = draft.profiles.find((item) => item.id === profileId)?.messages.find((item) => item.id === event.localId);
            if (message) message.delivery = 'failed';
          }).then(refresh);
        }
        setError(redactError(reason));
      }
      return;
    }
    if (event.type === 'state') {
      if (event.state !== 'encrypted') return;
      void vault.update((draft) => {
        const profile = draft.profiles.find((item) => item.id === profileId);
        const contact = profile?.contacts.find((item) => item.accountId === account.id && item.address === bareAddress(event.peer));
        const conversation = contact ? profile?.conversations.find((item) => item.contactId === contact.id) : undefined;
        if (!conversation) return;
        const previous = conversation.encryption?.devices.find((item) => item.id === `otr:${event.peer}`);
        const changed = Boolean(previous?.fingerprint && event.fingerprint && previous.fingerprint !== event.fingerprint);
        const device = {
          id: `otr:${event.peer}`, label: 'OTR v2/v3', fingerprint: event.fingerprint ?? '',
          trust: changed ? 'untrusted' as const : previous?.trust ?? 'untrusted' as const,
          firstSeenAt: previous?.firstSeenAt ?? Date.now(), changedAt: changed ? Date.now() : previous?.changedAt,
        };
        conversation.encryption = {
          policy: conversation.encryption?.policy ?? 'force-otr', provider: 'otr',
          verified: device.trust === 'trusted' && !changed, devices: [device], warning: changed ? 'changed-device' : device.trust === 'trusted' ? undefined : 'first-use',
        };
      }).then(refresh);
      return;
    }
    const profileName = vault.snapshot.profiles.find((item) => item.id === profileId)?.name ?? 'Relayless';
    let shouldNotify = false;
    let conversationTitle = bareAddress(event.peer);
    void vault.update((draft) => {
      const profile = draft.profiles.find((item) => item.id === profileId); if (!profile) return;
      const messageId = event.messageId || crypto.randomUUID();
      if (profile.messages.some((item) => item.id === messageId)) return;
      const bare = bareAddress(event.peer);
      let contact = profile.contacts.find((item) => item.accountId === account.id && item.address === bare);
      if (!contact) {
        contact = { id: crypto.randomUUID(), accountId: account.id, protocol: 'xmpp', address: bare, alias: bare, presence: 'online', resource: event.peer };
        profile.contacts.push(contact);
      } else contact.resource = event.peer;
      let conversation = profile.conversations.find((item) => item.contactId === contact.id);
      const fingerprint = manager.fingerprintFor(event.peer);
      const device = { id: `otr:${event.peer}`, label: 'OTR v2/v3', fingerprint, trust: 'untrusted' as const, firstSeenAt: Date.now() };
      if (!conversation) {
        conversation = { id: crypto.randomUUID(), contactId: contact.id, protocol: 'xmpp', title: contact.alias, unread: 0, updatedAt: event.timestamp ?? Date.now(), sourceAccountId: account.id, encryption: { policy: 'force-otr', provider: 'otr', verified: false, devices: [device], warning: 'first-use' } };
        profile.conversations.push(conversation);
      } else if (conversation.encryption?.provider !== 'otr') {
        conversation.encryption = { policy: conversation.encryption?.policy ?? 'force-otr', provider: 'otr', verified: false, devices: [device], warning: 'first-use' };
      }
      const timestamp = event.timestamp ?? Date.now();
      const visible = viewState.current.activeProfileId === profileId && viewState.current.screen === 'chats' && viewState.current.conversationId === conversation.id;
      recordIncomingActivity(conversation, visible, timestamp);
      conversationTitle = conversation.title; shouldNotify = !visible;
      profile.messages.push({ id: messageId, conversationId: conversation.id, direction: 'incoming', body: event.body, timestamp, delivery: 'delivered', sourceAccountId: account.id, encryptionProvider: 'otr' });
    }).then(() => {
      refresh();
      if (event.messageId) client.sendReceipt(event.peer, event.messageId);
      if (shouldNotify) showLocalMessageNotification(profileName, conversationTitle, event.body, vault.snapshot.settings.showNotificationPreviews);
    });
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
        const contact = resolveToxContact(profile, accountId, event.friendNumber, event.publicKey);
        if (!contact) return;
        contact.presence = 'online';
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
    let requestAdded = false;
    const notificationProfileName = vault.snapshot.profiles.find((item) => item.id === profileId)?.name ?? 'Relayless';
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
        reconcileToxFriends(profile, accountId, event.friends);
      }
      if (event.type === 'savedata') current.savedata = event.savedata;
      if (event.type === 'transport' && event.transport === 'tcp') {
        if (event.state === 'open') current.connectionDetail = languageHint(t, 'TCP-релей Tox подключён.', 'Tox TCP relay connected.');
        if (event.state === 'error') current.connectionDetail = languageHint(t, 'Переключаем Tox-релей…', 'Switching Tox relay…');
      }
      if (event.type === 'friend-request' && !profile.friendRequests.some((item) => item.accountId === accountId && item.publicKey === event.publicKey)) {
        profile.friendRequests.push({ id: crypto.randomUUID(), accountId, protocol: 'tox', publicKey: event.publicKey, message: event.message, receivedAt: Date.now() });
        requestAdded = true;
      }
      if (event.type === 'friend-connection') {
        const contact = resolveToxContact(profile, accountId, event.friendNumber, event.publicKey, true);
        if (contact) contact.presence = event.online ? 'online' : 'offline';
      }
      if (event.type === 'receipt') {
        const message = profile.messages.find((item) => item.sourceAccountId === accountId && item.protocolMessageId === String(event.messageId) && item.protocolPeerId === event.publicKey);
        if (message) message.delivery = 'delivered';
      }
    }).then(() => {
      refresh();
      if (event.type === 'friend-connection' && event.online) void flushPendingToxMessages(profileId, accountId, event.friendNumber);
      if (event.type === 'friend-request' && requestAdded) {
        showLocalMessageNotification(notificationProfileName, languageHint(t, 'Новый запрос Tox', 'New Tox request'), event.message || languageHint(t, 'Хочет добавить вас', 'Wants to add you'), vault.snapshot.settings.showNotificationPreviews);
      }
    }).catch((reason) => setError(redactError(reason)));
  };

  const flushPendingToxMessages = async (profileId: string, accountId: string, friendNumber: number): Promise<void> => {
    const client = toxClients.current.get(`${profileId}:${accountId}`);
    if (!client) return;
    const snapshot = vault.snapshot;
    const profile = snapshot.profiles.find((item) => item.id === profileId);
    const contact = profile?.contacts.find((item) => item.accountId === accountId && item.remoteId === String(friendNumber));
    if (!profile || !contact) return;
    const conversationIds = new Set(profile.conversations.filter((item) => item.contactId === contact.id).map((item) => item.id));
    const pending = profile.messages.filter((item) => item.direction === 'outgoing' && item.delivery === 'sending' && item.sourceAccountId === accountId && conversationIds.has(item.conversationId));
    for (const message of pending) {
      try {
        const messageId = await client.sendMessage(friendNumber, message.body);
        await vault.update((draft) => {
          const current = draft.profiles.find((item) => item.id === profileId)?.messages.find((item) => item.id === message.id);
          if (current) { current.protocolMessageId = String(messageId); current.protocolPeerId = contact.address; current.delivery = 'sent'; }
        });
      } catch { break; }
    }
    refresh();
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
      const publicKey = address.slice(0, 64).toUpperCase();
      const contact = resolveToxContact(profile, accountId, friendNumber, publicKey, true);
      if (!contact) throw new Error('Tox contact could not be saved');
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
      if (!resolveToxContact(profile, account.id, friendNumber, request.publicKey, true)) throw new Error('Tox contact could not be saved');
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
    validateOutgoingMessage(conversation.protocol, body, t);
    let provider: 'tox' | 'plaintext' | 'omemo' | 'otr' = source.protocol === 'tox' ? 'tox' : 'plaintext';
    if (source.protocol === 'xmpp') {
      const client = xmppClients.current.get(`${profileId}:${sourceAccountId}`);
      if (!client) throw new Error(languageHint(t, 'Сначала подключите XMPP-аккаунт.', 'Connect the XMPP account first.'));
      const policy = conversation.encryption?.policy ?? profile.settings.defaultEncryptionPolicy;
      if (policy === 'force-otr' && !otrManagers.current.has(`${profileId}:${sourceAccountId}`)) await initializeOtr(client, source, profileId);
      const omemoAvailable = omemoEngines.current.has(`${profileId}:${sourceAccountId}`);
      const otrAvailable = otrManagers.current.has(`${profileId}:${sourceAccountId}`) && Boolean(contact.resource);
      try {
        provider = resolveEncryptionProvider(policy, { omemo: omemoAvailable, otr: otrAvailable }, policy === 'plaintext') as 'plaintext' | 'omemo' | 'otr';
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
          : { policy: current.encryption?.policy ?? target.settings.defaultEncryptionPolicy, provider, verified: false, devices: current.encryption?.devices ?? [], warning: provider === 'omemo' || provider === 'otr' ? 'first-use' : 'tls-only' };
      }
      target.drafts[conversation.id] = '';
    });
    refresh();
    try {
      let sentId: string;
      let toxMessageId: number | undefined;
      let deferredOtr = false;
      if (source.protocol === 'tox') {
        const friendNumber = Number(contact.remoteId);
        if (!Number.isInteger(friendNumber) || friendNumber < 0) throw new Error('Tox contact is not linked to a toxcore friend');
        const client = await connectTox(source, profileId);
        try {
          toxMessageId = await client.sendMessage(friendNumber, body);
        } catch {
          setError(languageHint(t, 'Контакт временно не в сети. Сообщение отправится автоматически после восстановления связи.', 'The contact is temporarily offline. The message will be sent automatically when the connection returns.'));
          return;
        }
        sentId = pendingId;
      } else {
        const client = xmppClients.current.get(`${profileId}:${sourceAccountId}`);
        if (!client) throw new Error(languageHint(t, 'Сначала подключите XMPP-аккаунт.', 'Connect the XMPP account first.'));
        await client.waitUntilOnline(25_000);
        if (provider === 'omemo') {
          const engine = omemoEngines.current.get(`${profileId}:${sourceAccountId}`);
          if (!engine) throw new Error('OMEMO is not ready; message was not sent');
          const encrypted = await engine.encrypt(contact.address, body);
          sentId = client.sendEncryptedMessage(contact.address, encrypted.xml, encrypted.namespace, Boolean(source.mamEnabled));
          await vault.update((draft) => {
            const current = draft.profiles.find((item) => item.id === profileId)?.conversations.find((item) => item.id === conversation.id);
            if (!current) return;
            const previous = current.encryption?.devices ?? [];
            const recipientDevices = encrypted.devices.filter((item) => item.jid === contact.address.split('/')[0]);
            const devices = recipientDevices.map((item) => ({
                id: `${item.jid}:${item.deviceId}`, label: `XMPP ${item.deviceId}`, fingerprint: item.fingerprint,
                trust: previous.find((known) => known.fingerprint === item.fingerprint)?.trust ?? 'untrusted', firstSeenAt: Date.now(),
              }));
            const verified = devices.length > 0 && devices.every((item) => item.trust === 'trusted');
            current.encryption = {
              policy: current.encryption?.policy ?? 'secure-auto', provider: 'omemo', verified,
              devices,
              warning: encrypted.skippedDevices.some((item) => item.jid === contact.address.split('/')[0])
                ? 'stale-device'
                : verified ? undefined : 'first-use',
              skippedDevices: encrypted.skippedDevices.filter((item) => item.jid === contact.address.split('/')[0]).length || undefined,
            };
          });
        } else if (provider === 'otr') {
          if (!contact.resource) throw new Error(languageHint(t, 'OTR требует, чтобы конкретное устройство контакта было в сети.', 'OTR requires a specific contact device to be online.'));
          const manager = otrManagers.current.get(`${profileId}:${sourceAccountId}`);
          if (!manager) throw new Error('OTR is not ready; message was not sent');
          await manager.send(contact.resource, body, pendingId);
          sentId = pendingId;
          deferredOtr = true;
        } else sentId = client.sendMessage(contact.address, body, Boolean(source.mamEnabled));
      }
      if (!deferredOtr) await vault.update((draft) => {
        const message = draft.profiles.find((item) => item.id === profileId)?.messages.find((item) => item.id === pendingId);
        if (message) {
          message.id = sentId;
          message.delivery = 'sent';
          if (source.protocol === 'tox') {
            message.protocolMessageId = String(toxMessageId!);
            message.protocolPeerId = contact.address;
          }
        }
      });
      refresh();
    } catch (reason) {
      await vault.update((draft) => {
        const message = draft.profiles.find((item) => item.id === profileId)?.messages.find((item) => item.id === pendingId);
        if (message) message.delivery = 'failed';
      });
      refresh();
      setError(isOmemoUnavailableError(reason)
        ? languageHint(t, 'У контакта нет доступных устройств OMEMO. Сообщение не отправлено — обновите ключи или выберите TLS вручную.', 'The contact has no reachable OMEMO devices. The message was not sent — refresh keys or choose TLS manually.')
        : redactError(reason));
      throw reason;
    }
  };

  const retryMessage = async (profileId: string, conversation: Conversation, message: Message) => {
    if (message.delivery !== 'failed') return;
    const snapshot = vault.snapshot;
    const profile = snapshot.profiles.find((item) => item.id === profileId);
    const sourceAccountId = message.sourceAccountId ?? conversation.sourceAccountId ?? profile?.ui.lastChannelByConversation[conversation.id];
    if (!sourceAccountId) throw new Error(languageHint(t, 'Выберите аккаунт для отправки.', 'Choose an account to send from.'));
    await vault.update((draft) => {
      const target = draft.profiles.find((item) => item.id === profileId);
      if (target) target.messages = target.messages.filter((item) => item.id !== message.id);
    });
    refresh();
    await sendMessage(profileId, conversation, message.body, sourceAccountId);
  };

  const warmConversationEncryption = (profileId: string, conversationId: string) => {
    const snapshot = vault.snapshot;
    const profile = snapshot.profiles.find((item) => item.id === profileId);
    const conversation = profile?.conversations.find((item) => item.id === conversationId);
    const contact = profile?.contacts.find((item) => item.id === conversation?.contactId);
    const sourceAccountId = conversation?.sourceAccountId ?? (conversation ? profile?.ui.lastChannelByConversation[conversation.id] : undefined) ?? contact?.accountId;
    if (!contact || contact.protocol !== 'xmpp' || !sourceAccountId) return;
    void omemoEngines.current.get(`${profileId}:${sourceAccountId}`)?.warmup(contact.address).catch(() => undefined);
  };

  const selectConversation = async (profileId: string, conversationId: string) => {
    if (data.activeProfileId !== profileId) await selectProfile(profileId);
    else {
      const optimistic = structuredClone(data);
      const profile = optimistic.profiles.find((item) => item.id === profileId);
      if (profile) {
        profile.ui.lastConversationId = conversationId;
        const conversation = profile.conversations.find((item) => item.id === conversationId);
        if (conversation) conversation.unread = 0;
        setData(optimistic);
      }
      setProfileScope(profileId);
      setSelectedConversation(conversationId);
    }
    try {
      await vault.update((draft) => { const profile = draft.profiles.find((item) => item.id === profileId); if (profile) { profile.ui.lastConversationId = conversationId; const conversation = profile.conversations.find((item) => item.id === conversationId); if (conversation) conversation.unread = 0; } });
      refresh(); setProfileScope(profileId); setSelectedConversation(conversationId); warmConversationEncryption(profileId, conversationId);
    } catch (reason) { refresh(); setError(redactError(reason)); throw reason; }
  };

  const openContact = async (contactId: string) => {
    const latest = vault.snapshot;
    const profileId = latest.activeProfileId;
    const current = activeProfile(latest);
    if (!current.contacts.some((item) => item.id === contactId)) throw new Error('Contact is no longer available');
    const conversationId = current.conversations.find((item) => item.contactId === contactId)?.id ?? crypto.randomUUID();
    const optimistic = structuredClone(latest);
    const optimisticProfile = optimistic.profiles.find((item) => item.id === profileId);
    if (!optimisticProfile) throw new Error('Profile is no longer available');
    const optimisticConversation = ensureConversation(optimisticProfile, contactId, Date.now(), conversationId);
    optimisticConversation.unread = 0;
    optimisticProfile.ui.lastConversationId = conversationId;
    setData(optimistic);
    setProfileScope(profileId);
    setSelectedConversation(conversationId);
    setScreen('chats');
    try {
      await vault.update((draft) => {
      const profile = draft.profiles.find((item) => item.id === profileId);
      if (!profile) return;
      const conversation = ensureConversation(profile, contactId, Date.now(), conversationId);
      conversation.unread = 0;
      profile.ui.lastConversationId = conversationId;
      });
      refresh();
      warmConversationEncryption(profileId, conversationId);
    } catch (reason) {
      refresh();
      setError(redactError(reason));
      throw reason;
    }
  };

  const renameContact = async (contactId: string, name: string) => {
    const profileId = data.activeProfileId;
    const alias = name.trim().replace(/\s+/g, ' ').slice(0, 128);
    if (!alias) throw new Error(languageHint(t, 'Введите имя контакта.', 'Enter a contact name.'));
    await vault.update((draft) => {
      const profile = draft.profiles.find((item) => item.id === profileId);
      const contact = profile?.contacts.find((item) => item.id === contactId);
      if (!profile || !contact) throw new Error('Contact is no longer available');
      contact.alias = alias;
      const conversation = profile.conversations.find((item) => item.contactId === contact.id);
      if (conversation) conversation.title = alias;
    });
    refresh();
  };

  const setConversationSource = async (profileId: string, conversationId: string, accountId: string) => {
    await vault.update((draft) => { const profile = draft.profiles.find((item) => item.id === profileId); const conversation = profile?.conversations.find((item) => item.id === conversationId); if (profile && conversation) { conversation.sourceAccountId = accountId; profile.ui.lastChannelByConversation[conversationId] = accountId; } }); refresh();
  };

  const saveDraft = async (profileId: string, conversationId: string, body: string) => {
    await vault.update((draft) => { const profile = draft.profiles.find((item) => item.id === profileId); if (profile) profile.drafts[conversationId] = body; }); refresh();
  };

  const setConversationEncryptionPolicy = async (profileId: string, conversationId: string, policy: 'secure-auto' | 'force-omemo' | 'force-otr' | 'plaintext') => {
    const snapshot = vault.snapshot.profiles.find((item) => item.id === profileId);
    const existingConversation = snapshot?.conversations.find((item) => item.id === conversationId);
    const contact = snapshot?.contacts.find((item) => item.id === existingConversation?.contactId);
    const accountId = existingConversation?.sourceAccountId ?? (existingConversation ? snapshot?.ui.lastChannelByConversation[existingConversation.id] : undefined);
    if (existingConversation?.encryption?.provider === 'otr' && policy !== 'force-otr' && contact?.resource && accountId) {
      await otrManagers.current.get(`${profileId}:${accountId}`)?.end(contact.resource).catch(() => undefined);
    }
    await vault.update((draft) => {
      const conversation = draft.profiles.find((item) => item.id === profileId)?.conversations.find((item) => item.id === conversationId);
      if (!conversation || conversation.protocol !== 'xmpp') return;
      const previous = conversation.encryption;
      conversation.encryption = {
        policy,
        provider: policy === 'plaintext' ? 'plaintext' : policy === 'force-otr' ? 'otr' : previous?.provider === 'omemo' ? 'omemo' : 'plaintext',
        verified: policy !== 'plaintext' && Boolean(previous?.verified),
        devices: previous?.devices ?? [],
        warning: policy === 'plaintext' ? 'tls-only' : previous?.verified ? undefined : 'first-use',
      };
    });
    refresh();
  };

  const deleteConversation = async (profileId: string, conversationId: string) => {
    const snapshot = vault.snapshot.profiles.find((item) => item.id === profileId);
    const conversation = snapshot?.conversations.find((item) => item.id === conversationId);
    const contact = snapshot?.contacts.find((item) => item.id === conversation?.contactId);
    const accountId = conversation?.sourceAccountId ?? (conversation ? snapshot?.ui.lastChannelByConversation[conversation.id] : undefined);
    if (conversation?.encryption?.provider === 'otr' && contact?.resource && accountId) {
      await otrManagers.current.get(`${profileId}:${accountId}`)?.end(contact.resource).catch(() => undefined);
    }
    await vault.update((draft) => {
      const profile = draft.profiles.find((item) => item.id === profileId); if (!profile) return;
      profile.messages = profile.messages.filter((item) => item.conversationId !== conversationId);
      profile.conversations = profile.conversations.filter((item) => item.id !== conversationId);
      delete profile.drafts[conversationId];
      delete profile.ui.lastChannelByConversation[conversationId];
      if (profile.ui.lastConversationId === conversationId) profile.ui.lastConversationId = undefined;
    });
    if (data.activeProfileId === profileId && selectedConversation === conversationId) setSelectedConversation(undefined);
    refresh();
  };

  const deleteContact = async (contactId: string) => {
    const profileId = data.activeProfileId;
    const snapshot = vault.snapshot.profiles.find((item) => item.id === profileId);
    const contact = snapshot?.contacts.find((item) => item.id === contactId);
    const account = snapshot?.accounts.find((item) => item.id === contact?.accountId);
    if (!snapshot || !contact || !account) return;
    try {
      if (contact.protocol === 'tox' && contact.remoteId !== undefined) {
        const client = toxClients.current.get(`${profileId}:${account.id}`);
        if (client) await client.removeFriend(Number(contact.remoteId));
      } else if (contact.protocol === 'xmpp') {
        if (contact.resource) await otrManagers.current.get(`${profileId}:${account.id}`)?.end(contact.resource).catch(() => undefined);
        xmppClients.current.get(`${profileId}:${account.id}`)?.removeContact(contact.address);
      }
    } catch (reason) { setError(redactError(reason)); }
    await vault.update((draft) => {
      const profile = draft.profiles.find((item) => item.id === profileId); if (!profile) return;
      const conversationIds = new Set(profile.conversations.filter((item) => item.contactId === contactId).map((item) => item.id));
      profile.contacts = profile.contacts.filter((item) => item.id !== contactId);
      profile.conversations = profile.conversations.filter((item) => !conversationIds.has(item.id));
      profile.messages = profile.messages.filter((item) => !conversationIds.has(item.conversationId));
      for (const id of conversationIds) { delete profile.drafts[id]; delete profile.ui.lastChannelByConversation[id]; }
      if (profile.ui.lastConversationId && conversationIds.has(profile.ui.lastConversationId)) profile.ui.lastConversationId = undefined;
    });
    setSelectedConversation(undefined);
    refresh();
  };

  const renameProfileFromMenu = async (profile: LocalProfile) => {
    const next = window.prompt(languageHint(t, 'Новое имя профиля', 'New profile name'), profile.name)?.trim();
    if (!next) return;
    await vault.update((draft) => { const target = draft.profiles.find((item) => item.id === profile.id); if (target) { target.name = next.slice(0, 128); target.initials = next.slice(0, 2).toUpperCase(); } });
    refresh();
  };

  const deleteProfileFromMenu = async (profile: LocalProfile) => {
    if (data.profiles.length === 1 || !window.confirm(languageHint(t, `Удалить профиль «${profile.name}» и все его локальные данные?`, `Delete profile “${profile.name}” and all its local data?`))) return;
    for (const account of profile.accounts) {
      const key = `${profile.id}:${account.id}`;
      xmppClients.current.get(key)?.stop(); xmppClients.current.delete(key); omemoEngines.current.delete(key); omemoInitializations.current.delete(key);
      otrManagers.current.get(key)?.close(); otrManagers.current.delete(key); otrInitializations.current.delete(key);
      await toxClients.current.get(key)?.stop().catch(() => undefined); toxClients.current.delete(key);
    }
    await vault.update((draft) => deleteProfile(draft, profile.id));
    setSelectedConversation(undefined); setProfileScope('all'); refresh();
  };

  const setConversationDeviceTrust = async (profileId: string, conversationId: string, deviceId: string, trusted: boolean) => {
    await vault.update((draft) => {
      const conversation = draft.profiles.find((item) => item.id === profileId)?.conversations.find((item) => item.id === conversationId);
      const device = conversation?.encryption?.devices.find((item) => item.id === deviceId);
      if (!conversation?.encryption || !device) throw new Error('Encryption device is no longer available');
      device.trust = trusted ? 'trusted' : 'untrusted';
      conversation.encryption.verified = conversation.encryption.devices.length > 0 && conversation.encryption.devices.every((item) => item.trust === 'trusted');
      conversation.encryption.warning = conversation.encryption.verified ? undefined : device.changedAt ? 'changed-device' : 'first-use';
    });
    refresh();
  };

  const disconnectAccount = async (account: Account) => {
    const key = `${data.activeProfileId}:${account.id}`;
    xmppClients.current.get(key)?.stop(); xmppClients.current.delete(key); omemoEngines.current.delete(key); omemoInitializations.current.delete(key);
    otrManagers.current.get(key)?.close(); otrManagers.current.delete(key); otrInitializations.current.delete(key);
    await toxClients.current.get(key)?.stop(); toxClients.current.delete(key);
    await vault.update((draft) => {
      const current = activeProfile(draft).accounts.find((item) => item.id === account.id);
      if (current) { current.presence = 'offline'; current.connectionState = 'offline'; current.connectionDetail = undefined; }
    });
    refresh();
  };

  const removeAccount = async (account: Account) => {
    const engine = omemoEngines.current.get(`${data.activeProfileId}:${account.id}`);
    if (engine) await engine.revoke().catch((reason) => setError(redactError(reason)));
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
      delete profile.omemoAccounts[account.id];
      delete profile.otrAccounts[account.id];
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
          <ProfileRail data={data} scope={profileScope} onAll={() => { setProfileScope('all'); setScreen('chats'); setSelectedConversation(undefined); }} onSelect={(id) => void selectProfile(id)} onCreate={() => void createNewProfile()} onReorder={(draggedId, targetId) => void vault.update((draft) => reorderProfiles(draft, draggedId, targetId)).then(refresh)} onPalette={() => setPaletteOpen(true)} onRename={(profile) => void renameProfileFromMenu(profile)} onDelete={(profile) => void deleteProfileFromMenu(profile)} onExport={(profile) => void vault.exportProfile(profile.id).then((payload) => downloadText(payload, `${safeFilename(profile.name)}.rlprofile`)).catch((reason) => setError(redactError(reason)))}/>
          <Nav screen={screen} setScreen={setScreen} pendingContacts={data.profiles.reduce((count, profile) => count + profile.friendRequests.length, 0)} t={t}/>
          <button className="sidebar-lock" onClick={lock} aria-label={t.lock} title={t.lock}><LockIcon/></button>
        </aside>
        <main className="workspace">
          <WorkspaceErrorBoundary resetKey={`${screen}:${currentProfile.id}`} language={language}>
          {screen === 'chats' && <Messenger data={data} scope={profileScope} selected={selectedConversation} onBack={() => setSelectedConversation(undefined)} selectConversation={selectConversation} setScreen={setScreen} sendMessage={sendMessage} retryMessage={retryMessage} setSource={setConversationSource} saveDraft={saveDraft} setDeviceTrust={setConversationDeviceTrust} setEncryptionPolicy={setConversationEncryptionPolicy} deleteConversation={deleteConversation} t={t}/>}
          {screen === 'accounts' && <Accounts profile={currentProfile} addXmpp={addXmpp} connectXmpp={(account) => connectXmpp(account, currentProfile.id)} addTox={addTox} connectTox={(account) => connectTox(account, currentProfile.id)} disconnectAccount={disconnectAccount} removeAccount={removeAccount} exportAccount={async (account) => { try { let exportPassword: string | undefined; if (!vault.isPersistent) { exportPassword = window.prompt(languageHint(t, 'Придумайте пароль для зашифрованной копии (минимум 10 символов)', 'Create a password for the encrypted backup (at least 10 characters)'))?.trim(); if (!exportPassword) return; } downloadText(await vault.exportAccount(currentProfile.id, account.id, exportPassword), `${safeFilename(account.alias)}.rlaccount`); } catch (reason) { setError(redactError(reason)); } }} t={t}/>}
          {screen === 'contacts' && <Contacts profile={currentProfile} acceptToxFriend={acceptToxFriend} rejectToxFriend={rejectToxFriend} addXmppContact={addXmppContact} addToxFriend={addToxFriend} openContact={openContact} renameContact={renameContact} deleteContact={deleteContact} goToAccounts={() => setScreen('accounts')} t={t}/>}
          {screen === 'privacy' && <Privacy data={data} profile={currentProfile} network={network} t={t} onLock={() => void lock()} onWipe={async () => { await vault.wipe(); setData(undefined); setGate('launch'); }} onExport={async () => downloadText(await vault.exportEncrypted(), 'relayless-vault.rlvault')}/>}
          {screen === 'plugins' && <Plugins data={data} t={t} onInstall={async (source, granted) => { const manifest = parsePluginManifest(source); await vault.update((draft) => { draft.plugins = installPlugin(manifest, granted, draft.plugins); }); refresh(); }} onToggle={async (id) => { await vault.update((draft) => { const plugin = draft.plugins.find((item) => item.manifest.id === id); if (plugin) plugin.enabled = !plugin.enabled; }); refresh(); }} onRemove={async (id) => { await vault.update((draft) => { draft.plugins = draft.plugins.filter((item) => item.manifest.id !== id); }); refresh(); }}/>}
          {screen === 'settings' && <Settings data={data} profile={currentProfile} t={t} onSave={updateSettings} onProfileUpdate={async (settings) => { await vault.update((draft) => { const profile = draft.profiles.find((item) => item.id === currentProfile.id); if (profile) profile.settings = settings; }); refresh(); }} onRename={async (name) => { await vault.update((draft) => { const profile = draft.profiles.find((item) => item.id === currentProfile.id); if (profile) { profile.name = name; profile.initials = name.slice(0, 2).toUpperCase(); } }); refresh(); }} onPin={async () => { await vault.update((draft) => { const profile = draft.profiles.find((item) => item.id === currentProfile.id); if (profile) profile.pinned = !profile.pinned; }); refresh(); }} onAvatar={async (avatar) => { await vault.update((draft) => { const profile = draft.profiles.find((item) => item.id === currentProfile.id); if (profile) profile.avatar = avatar; }); refresh(); }} onLockProfile={async () => { for (const account of currentProfile.accounts) { const key = `${currentProfile.id}:${account.id}`; xmppClients.current.get(key)?.stop(); xmppClients.current.delete(key); omemoEngines.current.delete(key); void toxClients.current.get(key)?.stop(); toxClients.current.delete(key); } await vault.update((draft) => { const profile = draft.profiles.find((item) => item.id === currentProfile.id); if (profile) { profile.locked = true; profile.runtimeState = 'locked'; } }); refresh(); setProfileScope('all'); setSelectedConversation(undefined); setScreen('chats'); }} onDuplicate={async () => { await vault.update((draft) => duplicateProfileSettings(draft, currentProfile.id, `${currentProfile.name} copy`)); refresh(); }} onEphemeral={() => void createNewProfile(true)} onDelete={async () => { for (const account of currentProfile.accounts) { const key = `${currentProfile.id}:${account.id}`; xmppClients.current.get(key)?.stop(); omemoEngines.current.delete(key); void toxClients.current.get(key)?.stop(); } await vault.update((draft) => deleteProfile(draft, currentProfile.id)); refresh(); }} onExportProfile={async () => downloadText(await vault.exportProfile(currentProfile.id), `${safeFilename(currentProfile.name)}.rlprofile`)} onImportProfile={async (text) => { const id = await vault.importProfile(text); refresh(); await selectProfile(id); }}/>}
          </WorkspaceErrorBoundary>
        </main>
      </div>
      <CommandPalette open={paletteOpen} profiles={data.profiles} pluginCommands={availablePluginCommands(data.plugins)} onPluginCommand={(action) => { const screens: Record<typeof action, Screen> = { 'open-chats': 'chats', 'open-accounts': 'accounts', 'open-contacts': 'contacts', 'open-settings': 'settings' }; setScreen(screens[action]); }} onClose={() => setPaletteOpen(false)} onProfile={(id) => void selectProfile(id)} onScope={setProfileScope} onCreate={() => void createNewProfile()}/>
      {error && <div className="error-strip" role="alert"><span>ERR</span>{error}<button onClick={() => setError('')} aria-label="Close">×</button></div>}
    </div>
  );
}

function Nav({ screen, setScreen, pendingContacts, t }: { screen: Screen; setScreen: (value: Screen) => void; pendingContacts: number; t: typeof copy[Language] }) {
  const items: Array<[Screen, string, typeof ChatIcon]> = [['chats', t.chats, ChatIcon], ['accounts', t.accounts, AccountsIcon], ['contacts', t.contacts, ContactsIcon], ['privacy', t.privacy, ShieldIcon], ['plugins', languageHint(t, 'Расширения', 'Extensions'), PluginsIcon], ['settings', t.settings, SettingsIcon]];
  return <nav className="rail" aria-label="Primary">{items.map(([id, label, ItemIcon]) => <button key={id} className={screen === id ? 'active' : ''} onClick={() => setScreen(id)} aria-label={label} title={label}><span className="nav-icon"><ItemIcon/>{id === 'contacts' && pendingContacts > 0 && <span className="nav-badge" aria-label={`${pendingContacts}`}>{pendingContacts > 99 ? '99+' : pendingContacts}</span>}</span><span>{label}</span></button>)}</nav>;
}

class WorkspaceErrorBoundary extends Component<{ resetKey: string; language: Language; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Keep active protocol clients mounted while only the failed view is restored.
  }

  componentDidUpdate(previous: Readonly<{ resetKey: string }>): void {
    if (previous.resetKey !== this.props.resetKey && this.state.failed) this.setState({ failed: false });
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const ru = this.props.language === 'ru';
    return <section className="workspace-error" role="alert"><strong>{ru ? 'Не удалось показать этот экран' : 'This screen could not be shown'}</strong><p>{ru ? 'Соединение продолжает работать. Верните интерфейс без обновления страницы.' : 'The connection is still running. Restore the interface without reloading the page.'}</p><button className="primary compact" onClick={() => this.setState({ failed: false })}>{ru ? 'Вернуть экран' : 'Restore screen'}</button></section>;
  }
}

function FirstLaunch({ language, setLanguage, error, createPersistent, createEphemeral }: { language: Language; setLanguage: (value: Language) => void; error: string; createPersistent: (password: string, rememberDevice: boolean) => Promise<void>; createEphemeral: () => void }) {
  const [password, setPassword] = useState(''); const [rememberDevice, setRememberDevice] = useState(true); const t = copy[language];
  const isRu = language === 'ru';
  return <div className="gate-page"><main className="gate-card"><div className="language-switch"><button className={language === 'ru' ? 'active' : ''} onClick={() => setLanguage('ru')}>RU</button><button className={language === 'en' ? 'active' : ''} onClick={() => setLanguage('en')}>EN</button></div><h1>{isRu ? 'Начать пользоваться' : 'Get started'}</h1><p>{isRu ? 'Придумайте пароль. Он защищает ваши чаты на этом устройстве.' : 'Create a password to protect your chats on this device.'}</p><form onSubmit={(event) => { event.preventDefault(); void createPersistent(password, rememberDevice); }}><label>{isRu ? 'Пароль' : 'Password'}<input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={10} placeholder="••••••••••••"/></label><span className="field-note">{t.passwordHint}</span><label className="device-unlock-check"><input type="checkbox" checked={rememberDevice} onChange={(event) => setRememberDevice(event.target.checked)}/><span><strong>{isRu ? 'Запомнить на этом устройстве' : 'Remember on this device'}</strong><small>{isRu ? 'После обновления страница откроется сама. Блокировка отключит автодоступ.' : 'Refreshes will open automatically. Locking disables automatic access.'}</small></span></label><button className="primary" type="submit">{isRu ? 'Продолжить' : 'Continue'}</button></form><div className="gate-divider"><span>{isRu ? 'или' : 'or'}</span></div><button className="text-action" onClick={createEphemeral}>{isRu ? 'Открыть без сохранения' : 'Open without saving'}</button>{error && <div className="inline-error">{error}</div>}</main></div>;
}

function Unlock({ language, setLanguage, error, unlock }: { language: Language; setLanguage: (value: Language) => void; error: string; unlock: (password: string, rememberDevice: boolean) => Promise<void> }) {
  const [password, setPassword] = useState(''); const [rememberDevice, setRememberDevice] = useState(true);
  const isRu = language === 'ru';
  return <div className="unlock-page"><main className="unlock-box"><div className="language-switch"><button className={language === 'ru' ? 'active' : ''} onClick={() => setLanguage('ru')}>RU</button><button className={language === 'en' ? 'active' : ''} onClick={() => setLanguage('en')}>EN</button></div><div className="unlock-avatar"><LockIcon/></div><h1>{isRu ? 'Введите пароль' : 'Enter password'}</h1><p>{isRu ? 'Чтобы открыть ваши чаты' : 'To open your chats'}</p><form onSubmit={(event) => { event.preventDefault(); void unlock(password, rememberDevice); }}><input autoFocus type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="••••••••••••"/><label className="device-unlock-check"><input type="checkbox" checked={rememberDevice} onChange={(event) => setRememberDevice(event.target.checked)}/><span><strong>{isRu ? 'Запомнить на этом устройстве' : 'Remember on this device'}</strong><small>{isRu ? 'Не спрашивать пароль после обновления страницы' : 'Do not ask after refreshing the page'}</small></span></label><button className="primary" type="submit">{isRu ? 'Открыть' : 'Open'}</button></form>{error && <div className="inline-error">{error}</div>}</main></div>;
}

function Messenger({ data, scope, selected, onBack, selectConversation, setScreen, sendMessage, retryMessage, setSource, saveDraft, setDeviceTrust, setEncryptionPolicy, deleteConversation, t }: { data: VaultData; scope: ProfileScope; selected?: string; onBack: () => void; selectConversation: (profileId: string, conversationId: string) => Promise<void>; setScreen: (screen: Screen) => void; sendMessage: (profileId: string, conversation: Conversation, body: string, sourceAccountId: string) => Promise<void>; retryMessage: (profileId: string, conversation: Conversation, message: Message) => Promise<void>; setSource: (profileId: string, conversationId: string, accountId: string) => Promise<void>; saveDraft: (profileId: string, conversationId: string, body: string) => Promise<void>; setDeviceTrust: (profileId: string, conversationId: string, deviceId: string, trusted: boolean) => Promise<void>; setEncryptionPolicy: (profileId: string, conversationId: string, policy: 'secure-auto' | 'force-omemo' | 'force-otr' | 'plaintext') => Promise<void>; deleteConversation: (profileId: string, conversationId: string) => Promise<void>; t: typeof copy[Language] }) {
  const [query, setQuery] = useState('');
  const context = useContextMenu<{ profile: LocalProfile; conversation: Conversation }>();
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
    return <button key={`${owner.id}:${conversation.id}`} className={owner.id === profile.id && conversation.id === selected ? 'selected' : ''} onClick={() => void selectConversation(owner.id, conversation.id)} onContextMenu={(event) => context.open(event, { profile: owner, conversation })} title={languageHint(t, 'ПКМ — действия с чатом', 'Right-click for chat actions')}><span className="chat-avatar conversation-avatar">{conversation.title.slice(0, 2).toUpperCase()}<span className={`protocol-mini ${contact?.presence ?? 'offline'}`}>{conversation.protocol === 'tox' ? <ToxIcon/> : <XmppIcon/>}</span></span><span className="conversation-copy"><strong>{conversation.title}</strong><small>{scope === 'all' ? `${owner.name}: ` : ''}{lastMessage(owner.messages, conversation.id)?.body ?? languageHint(t, 'Новый диалог', 'New conversation')}</small></span><span className="conversation-meta"><time>{formatTime(conversation.updatedAt)}</time>{conversation.unread > 0 && <b>{conversation.unread}</b>}</span></button>;
  })}{rows.length === 0 && <EmptyState title={query ? languageHint(t, 'Ничего не найдено', 'Nothing found') : t.noConversations} text={query ? languageHint(t, 'Попробуйте другой запрос.', 'Try another search.') : hasContacts ? languageHint(t, 'Выберите контакт и начните диалог.', 'Choose a contact and start a conversation.') : languageHint(t, 'Подключите аккаунт, чтобы начать общение.', 'Connect an account to start chatting.')} >{!query && <button className="primary compact-action" onClick={() => setScreen(newChatScreen)}>{newChatLabel}</button>}</EmptyState>}</div></section><section className="chat-panel">{current ? <ActiveChat profile={profile} conversation={current} messages={messages} onBack={onBack} send={sendMessage} retry={retryMessage} setSource={setSource} saveDraft={saveDraft} setDeviceTrust={setDeviceTrust} setEncryptionPolicy={setEncryptionPolicy} t={t}/> : <div className="chat-idle"><div className="idle-bubble"><ChatIcon/></div><strong>{languageHint(t, 'Выберите чат', 'Choose a chat')}</strong><p>{languageHint(t, 'Здесь появятся сообщения.', 'Messages will appear here.')}</p></div>}</section>{context.menu && (() => { const owner = context.menu.value.profile; const conversation = context.menu.value.conversation; const contact = owner.contacts.find((item) => item.id === conversation.contactId); const latest = lastMessage(owner.messages, conversation.id); return <ContextMenu state={context.menu} onClose={context.close} items={[
    { label: languageHint(t, 'Открыть чат', 'Open chat'), action: () => selectConversation(owner.id, conversation.id) },
    { label: languageHint(t, 'Копировать адрес', 'Copy address'), disabled: !contact?.address, action: () => navigator.clipboard.writeText(contact?.address ?? '') },
    { label: languageHint(t, 'Копировать последнее сообщение', 'Copy last message'), disabled: !latest, action: () => navigator.clipboard.writeText(latest?.body ?? '') },
    { label: languageHint(t, 'Удалить чат', 'Delete chat'), danger: true, action: () => { if (window.confirm(languageHint(t, `Удалить чат «${conversation.title}» и его локальную историю?`, `Delete “${conversation.title}” and its local history?`))) return deleteConversation(owner.id, conversation.id); } },
  ]}/>; })()}</div>;
}

type ActiveChatProps = {
  profile: LocalProfile;
  conversation: Conversation;
  messages: Message[];
  onBack: () => void;
  send: (profileId: string, conversation: Conversation, body: string, sourceAccountId: string) => Promise<void>;
  retry: (profileId: string, conversation: Conversation, message: Message) => Promise<void>;
  setSource: (profileId: string, conversationId: string, accountId: string) => Promise<void>;
  saveDraft: (profileId: string, conversationId: string, body: string) => Promise<void>;
  setDeviceTrust: (profileId: string, conversationId: string, deviceId: string, trusted: boolean) => Promise<void>;
  setEncryptionPolicy: (profileId: string, conversationId: string, policy: 'secure-auto' | 'force-omemo' | 'force-otr' | 'plaintext') => Promise<void>;
  t: typeof copy[Language];
};

function ActiveChat({ profile, conversation, messages, onBack, send, retry, setSource, saveDraft, setDeviceTrust, setEncryptionPolicy, t }: ActiveChatProps) {
  const [body, setBody] = useState(profile.drafts[conversation.id] ?? '');
  const [securityOpen, setSecurityOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(MESSAGE_RENDER_BATCH);
  const messagesEnd = useRef<HTMLDivElement>(null);
  const securityMenu = useRef<HTMLDivElement>(null);
  const lastSecurityToggle = useRef(0);

  useEffect(() => {
    setBody(profile.drafts[conversation.id] ?? '');
    setVisibleCount(MESSAGE_RENDER_BATCH);
    setSecurityOpen(false);
  }, [conversation.id, profile.drafts]);
  useEffect(() => { messagesEnd.current?.scrollIntoView?.({ block: 'end' }); }, [conversation.id, messages.length]);
  useEffect(() => {
    if (!securityOpen) return;
    const close = (event: PointerEvent) => {
      if (!securityMenu.current?.contains(event.target as Node)) setSecurityOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [securityOpen]);

  const hiddenMessageCount = Math.max(0, messages.length - visibleCount);
  const visibleMessages = hiddenMessageCount > 0 ? messages.slice(-visibleCount) : messages;
  const identities = profile.accounts.filter((account) => account.protocol === conversation.protocol);
  const sourceId = conversation.sourceAccountId ?? profile.ui.lastChannelByConversation[conversation.id] ?? (identities.length === 1 ? identities[0]?.id : undefined) ?? '';
  const contact = profile.contacts.find((item) => item.id === conversation.contactId);
  const security = encryptionLabel(conversation, t);
  const encryptionPolicy = conversation.encryption?.policy ?? 'secure-auto';
  const compactSecurityLabel = conversation.protocol === 'tox'
    ? 'Tox'
    : encryptionPolicy === 'plaintext'
      ? 'TLS'
      : encryptionPolicy === 'force-otr' || conversation.encryption?.provider === 'otr'
        ? 'OTR'
        : encryptionPolicy === 'force-omemo' || conversation.encryption?.provider === 'omemo'
        ? 'OMEMO'
        : languageHint(t, 'Авто', 'Auto');
  const chooseEncryption = (policy: 'secure-auto' | 'force-omemo' | 'force-otr' | 'plaintext') => {
    setSecurityOpen(false);
    void setEncryptionPolicy(profile.id, conversation.id, policy);
  };
  const toggleSecurity = () => {
    const now = performance.now();
    if (now - lastSecurityToggle.current < 240) return;
    lastSecurityToggle.current = now;
    setSecurityOpen((open) => !open);
  };

  return (
    <>
      <div className="chat-head">
        <button className="back-button" onClick={onBack} aria-label={languageHint(t, 'Назад', 'Back')}><ArrowIcon/></button>
        <span className="chat-avatar">{conversation.title.slice(0, 2).toUpperCase()}</span>
        <div className="chat-head-copy"><h2>{conversation.title}</h2><small>{presenceLabel(contact?.presence ?? 'offline', t)}</small></div>
      </div>
      <div className="messages">
        {messages.length === 0 && <div className="conversation-start"><strong>{conversation.title}</strong><span>{security.label}</span><p>{languageHint(t, 'Напишите первое сообщение.', 'Write the first message.')}</p></div>}
        {hiddenMessageCount > 0 && <button className="load-older" onClick={() => setVisibleCount((count) => count + MESSAGE_RENDER_BATCH)}>{languageHint(t, `Показать ещё ${Math.min(hiddenMessageCount, MESSAGE_RENDER_BATCH)}`, `Show ${Math.min(hiddenMessageCount, MESSAGE_RENDER_BATCH)} more`)}</button>}
        {visibleMessages.map((message) => (
          <article key={message.id} className={`${message.direction} ${message.delivery === 'failed' ? 'failed' : ''}`}>
            <p>{message.body}<span className="message-meta"><time>{formatTime(message.timestamp)}</time>{message.direction === 'outgoing' && <MessageDelivery state={message.delivery} t={t}/>}</span></p>
            {message.direction === 'outgoing' && message.delivery === 'failed' && <button className="retry-message" onClick={() => void retry(profile.id, conversation, message)}>{languageHint(t, 'Повторить', 'Retry')}</button>}
          </article>
        ))}
        <div className="message-anchor" ref={messagesEnd}/>
      </div>
      <form className="composer" onSubmit={(event) => {
        event.preventDefault();
        const value = body.trim();
        if (!value || !sourceId) return;
        setBody('');
        void send(profile.id, conversation, value, sourceId).catch(() => setBody(value));
      }}>
        <div className="composer-security-wrap" ref={securityMenu}>
          {conversation.protocol === 'xmpp' ? (
            <button
              type="button"
              className={`composer-security ${security.tone}`}
              onClick={toggleSecurity}
              aria-expanded={securityOpen}
              aria-haspopup="dialog"
              title={languageHint(t, 'Выбрать шифрование', 'Choose encryption')}
            ><ShieldIcon/><span>{compactSecurityLabel}</span></button>
          ) : (
            <span className="composer-security secure" title={security.label}><LockIcon/><span>Tox</span></span>
          )}
          {securityOpen && conversation.protocol === 'xmpp' && (
            <section className="security-popover" role="dialog" aria-label={languageHint(t, 'Настройки шифрования', 'Encryption settings')}>
              <div className="security-popover-title"><strong>{languageHint(t, 'Шифрование', 'Encryption')}</strong><small>{languageHint(t, 'Для этого чата', 'For this chat')}</small></div>
              <div className="encryption-options">
                <button type="button" className={encryptionPolicy === 'secure-auto' ? 'active' : ''} onClick={() => chooseEncryption('secure-auto')}><strong>{languageHint(t, 'Авто', 'Auto')}</strong><small>{languageHint(t, 'OMEMO, если доступно', 'OMEMO when available')}</small></button>
                <button type="button" className={encryptionPolicy === 'force-omemo' ? 'active' : ''} onClick={() => chooseEncryption('force-omemo')}><strong>OMEMO</strong><small>{languageHint(t, 'Только сквозное', 'End-to-end only')}</small></button>
                <button type="button" className={encryptionPolicy === 'force-otr' ? 'active legacy' : ''} onClick={() => chooseEncryption('force-otr')}><strong>OTR</strong><small>{languageHint(t, 'Для старых клиентов', 'For legacy clients')}</small></button>
                <button type="button" className={encryptionPolicy === 'plaintext' ? 'active warning' : ''} onClick={() => chooseEncryption('plaintext')}><strong>TLS</strong><small>{languageHint(t, 'Сервер видит текст', 'Server can read text')}</small></button>
              </div>
              {encryptionPolicy === 'force-otr' && <p className="encryption-caution legacy">{languageHint(t, 'OTR v2/v3 работает с одним онлайн-устройством контакта. Для новых клиентов лучше OMEMO.', 'OTR v2/v3 works with one online contact device. Prefer OMEMO for modern clients.')}</p>}
              {conversation.encryption?.warning === 'stale-device' && <p className="encryption-caution">{languageHint(t, `Пропущено устаревших устройств: ${conversation.encryption.skippedDevices ?? 1}.`, `Skipped stale devices: ${conversation.encryption.skippedDevices ?? 1}.`)}</p>}
              {encryptionPolicy !== 'plaintext' && (
                <details className="device-details">
                  <summary>{languageHint(t, `Устройства (${conversation.encryption?.devices.length ?? 0})`, `Devices (${conversation.encryption?.devices.length ?? 0})`)}</summary>
                  <div className="device-list">
                    {conversation.encryption?.devices.length === 0 && <p>{languageHint(t, 'Устройства появятся после первой защищённой отправки.', 'Devices appear after the first encrypted send.')}</p>}
                    {conversation.encryption?.devices.map((device) => (
                      <article className={device.changedAt ? 'changed' : ''} key={device.id}>
                        <div><strong>{device.label}</strong>{device.changedAt && <em>{languageHint(t, 'Ключ изменился', 'Key changed')}</em>}<code>{device.fingerprint || languageHint(t, 'Отпечаток недоступен', 'Fingerprint unavailable')}</code></div>
                        <button type="button" className={device.trust === 'trusted' ? 'trusted' : ''} disabled={!device.fingerprint} onClick={() => void setDeviceTrust(profile.id, conversation.id, device.id, device.trust !== 'trusted')}>{device.trust === 'trusted' ? languageHint(t, 'Проверено', 'Verified') : languageHint(t, 'Доверять', 'Trust')}</button>
                      </article>
                    ))}
                  </div>
                </details>
              )}
            </section>
          )}
        </div>
        {identities.length > 1 && <select className="identity-selector" aria-label={languageHint(t, 'Отправить от имени', 'Send as')} value={sourceId} onChange={(event) => void setSource(profile.id, conversation.id, event.target.value)} required><option value="" disabled>{languageHint(t, 'Выберите аккаунт', 'Choose account')}</option>{identities.map((identity) => <option key={identity.id} value={identity.id}>{identity.alias}</option>)}</select>}
        <textarea rows={1} value={body} onChange={(event) => setBody(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} onBlur={() => void saveDraft(profile.id, conversation.id, body)} placeholder={sourceId ? languageHint(t, 'Сообщение', 'Message') : languageHint(t, 'Сначала выберите аккаунт', 'Choose an account first')} maxLength={conversation.protocol === 'tox' ? TOX_MESSAGE_MAX_BYTES : XMPP_MESSAGE_MAX_BYTES}/>
        <button className="send-message" type="submit" title={t.send} aria-label={t.send} disabled={!sourceId || !body.trim()}><SendIcon/></button>
      </form>
    </>
  );
}

function ActiveChatLegacy({ profile, conversation, messages, onBack, send, retry, setSource, saveDraft, setDeviceTrust, setEncryptionPolicy, t }: ActiveChatProps) {
  const [body, setBody] = useState(profile.drafts[conversation.id] ?? '');
  const [securityOpen, setSecurityOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(MESSAGE_RENDER_BATCH);
  const messagesEnd = useRef<HTMLDivElement>(null);
  useEffect(() => { setBody(profile.drafts[conversation.id] ?? ''); setVisibleCount(MESSAGE_RENDER_BATCH); setSecurityOpen(false); }, [conversation.id, profile.drafts]);
  useEffect(() => { messagesEnd.current?.scrollIntoView?.({ block: 'end' }); }, [conversation.id, messages.length]);
  const hiddenMessageCount = Math.max(0, messages.length - visibleCount);
  const visibleMessages = hiddenMessageCount > 0 ? messages.slice(-visibleCount) : messages;
  const identities = profile.accounts.filter((account) => account.protocol === conversation.protocol);
  const sourceId = conversation.sourceAccountId ?? profile.ui.lastChannelByConversation[conversation.id] ?? (identities.length === 1 ? identities[0]?.id : undefined) ?? '';
  const contact = profile.contacts.find((item) => item.id === conversation.contactId);
  const security = encryptionLabel(conversation, t);
  const securityBadge = <>{conversation.protocol === 'tox' ? <ToxIcon/> : <XmppIcon/>}{security.label}</>;
  const encryptionPolicy = conversation.encryption?.policy ?? 'secure-auto';
  return <><div className="chat-head"><button className="back-button" onClick={onBack} aria-label={languageHint(t, 'Назад', 'Back')}><ArrowIcon/></button><span className="chat-avatar">{conversation.title.slice(0, 2).toUpperCase()}</span><div className="chat-head-copy"><h2>{conversation.title}</h2><small>{presenceLabel(contact?.presence ?? 'offline', t)}</small></div>{conversation.protocol === 'xmpp' ? <button className={`security-state ${security.tone}`} onClick={() => setSecurityOpen((open) => !open)} aria-expanded={securityOpen}>{securityBadge}</button> : <span className={`security-state ${security.tone}`}>{securityBadge}</span>}</div>{securityOpen && conversation.protocol === 'xmpp' && <section className="security-sheet" role="dialog" aria-label={languageHint(t, 'Настройки шифрования', 'Encryption settings')}><div className="security-sheet-head"><div><strong>{languageHint(t, 'Шифрование чата', 'Chat encryption')}</strong><small>{languageHint(t, 'OMEMO скрывает текст от сервера. TLS подходит клиентам без OMEMO.', 'OMEMO hides text from the server. TLS works with clients that do not support OMEMO.')}</small></div><button onClick={() => setSecurityOpen(false)} aria-label={languageHint(t, 'Закрыть', 'Close')}>×</button></div><div className="encryption-modes"><button className={encryptionPolicy === 'secure-auto' ? 'active' : ''} onClick={() => void setEncryptionPolicy(profile.id, conversation.id, 'secure-auto')}>{languageHint(t, 'Авто', 'Auto')}</button><button className={encryptionPolicy === 'force-omemo' ? 'active' : ''} onClick={() => void setEncryptionPolicy(profile.id, conversation.id, 'force-omemo')}>OMEMO</button><button className={encryptionPolicy === 'plaintext' ? 'active warning' : ''} onClick={() => void setEncryptionPolicy(profile.id, conversation.id, 'plaintext')}>TLS</button></div>{encryptionPolicy === 'plaintext' ? <p className="encryption-warning">{languageHint(t, 'Текст сможет прочитать XMPP-сервер. Выберите этот режим только для контактов без OMEMO.', 'The XMPP server can read message text. Use this only for contacts without OMEMO.')}</p> : <>{conversation.encryption?.warning === 'stale-device' && <p className="encryption-caution">{languageHint(t, `Пропущено устаревших устройств: ${conversation.encryption.skippedDevices ?? 1}. Сообщение зашифровано для остальных устройств.`, `Skipped stale devices: ${conversation.encryption.skippedDevices ?? 1}. The message was encrypted for the remaining devices.`)}</p>}{conversation.encryption?.devices.length === 0 ? <p>{languageHint(t, 'Устройства OMEMO появятся после первой защищённой отправки.', 'OMEMO devices will appear after the first encrypted send.')}</p> : conversation.encryption?.devices.map((device) => <article className={device.changedAt ? 'changed' : ''} key={device.id}><div><strong>{device.label}</strong>{device.changedAt && <em>{languageHint(t, 'Ключ изменился', 'Key changed')}</em>}<code>{device.fingerprint || languageHint(t, 'Отпечаток недоступен', 'Fingerprint unavailable')}</code></div><button className={device.trust === 'trusted' ? 'trusted' : ''} disabled={!device.fingerprint} onClick={() => void setDeviceTrust(profile.id, conversation.id, device.id, device.trust !== 'trusted')}>{device.trust === 'trusted' ? languageHint(t, 'Проверено', 'Verified') : languageHint(t, 'Доверять', 'Trust')}</button></article>)}</>}</section>}<div className="messages">{messages.length === 0 && <div className="conversation-start"><strong>{conversation.title}</strong><span>{security.label}</span><p>{languageHint(t, 'Напишите первое сообщение.', 'Write the first message.')}</p></div>}{hiddenMessageCount > 0 && <button className="load-older" onClick={() => setVisibleCount((count) => count + MESSAGE_RENDER_BATCH)}>{languageHint(t, `Показать ещё ${Math.min(hiddenMessageCount, MESSAGE_RENDER_BATCH)}`, `Show ${Math.min(hiddenMessageCount, MESSAGE_RENDER_BATCH)} more`)}</button>}{visibleMessages.map((message) => <article key={message.id} className={`${message.direction} ${message.delivery === 'failed' ? 'failed' : ''}`}><p>{message.body}<span className="message-meta"><time>{formatTime(message.timestamp)}</time>{message.direction === 'outgoing' && <MessageDelivery state={message.delivery} t={t}/>}</span></p>{message.direction === 'outgoing' && message.delivery === 'failed' && <button className="retry-message" onClick={() => void retry(profile.id, conversation, message)}>{languageHint(t, 'Повторить', 'Retry')}</button>}</article>)}<div className="message-anchor" ref={messagesEnd}/></div><form className="composer" onSubmit={(event) => { event.preventDefault(); const value = body.trim(); if (!value || !sourceId) return; setBody(''); void send(profile.id, conversation, value, sourceId).catch(() => setBody(value)); }}>{identities.length > 1 && <select className="identity-selector" aria-label={languageHint(t, 'Отправить от имени', 'Send as')} value={sourceId} onChange={(event) => void setSource(profile.id, conversation.id, event.target.value)} required><option value="" disabled>{languageHint(t, 'Выберите аккаунт', 'Choose account')}</option>{identities.map((identity) => <option key={identity.id} value={identity.id}>{identity.alias}</option>)}</select>}<textarea rows={1} value={body} onChange={(event) => setBody(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} onBlur={() => void saveDraft(profile.id, conversation.id, body)} placeholder={sourceId ? languageHint(t, 'Сообщение', 'Message') : languageHint(t, 'Сначала выберите аккаунт', 'Choose an account first')} maxLength={conversation.protocol === 'tox' ? TOX_MESSAGE_MAX_BYTES : XMPP_MESSAGE_MAX_BYTES}/><button type="submit" title={t.send} aria-label={t.send} disabled={!sourceId || !body.trim()}><SendIcon/></button></form></>;
}

void ActiveChatLegacy;

function Accounts({ profile, addXmpp, connectXmpp, addTox, connectTox, disconnectAccount, removeAccount, exportAccount, t }: { profile: LocalProfile; addXmpp: (account: Account) => Promise<void>; connectXmpp: (account: Account) => void; addTox: (alias: string, savedata?: string) => Promise<void>; connectTox: (account: Account) => Promise<ToxClient>; disconnectAccount: (account: Account) => Promise<void>; removeAccount: (account: Account) => Promise<void>; exportAccount: (account: Account) => Promise<void>; t: typeof copy[Language] }) {
  const [kind, setKind] = useState<'xmpp' | 'tox'>('xmpp');
  const [toxAlias, setToxAlias] = useState('Tox');
  const [toxImport, setToxImport] = useState('');
  const context = useContextMenu<Account>();
  const toxAvailable = hasToxTransport();
  return (
    <div className="content-grid">
      <section>
        <PageTitle index="02" title={t.accounts} subtitle={profile.name}/>
        <div className={`account-list ${profile.accounts.length === 0 ? 'is-empty' : ''}`}>
          {profile.accounts.map((account) => (
            <div className="account-row" key={account.id} onContextMenu={(event) => context.open(event, account)} title={languageHint(t, 'ПКМ — действия с аккаунтом', 'Right-click for account actions')}>
              <span className={`chat-avatar protocol-account ${account.protocol}`}>{account.protocol === 'xmpp' ? <XmppIcon/> : <ToxIcon/>}</span>
              <div><strong>{account.alias}</strong><small>{account.address}</small>{account.protocol === 'tox' && toxAvailable && <small className="connection-note">{languageHint(t, 'Защищённое подключение через Tox TCP.', 'Secure connection through Tox TCP.')}</small>}</div>
              <span className={`state ${account.protocol === 'tox' && !toxAvailable ? 'error' : account.connectionState ?? account.presence}`} title={account.connectionDetail}>{accountConnectionLabel(account, t)}</span>
              <div className="account-actions">
                {account.address && <button className="icon-text" onClick={() => void navigator.clipboard.writeText(account.address)}>{languageHint(t, 'Копировать', 'Copy')}</button>}
                <button className="icon-text" title={languageHint(t, 'Скачать зашифрованную копию аккаунта', 'Download an encrypted account backup')} onClick={() => void exportAccount(account)}>{languageHint(t, 'Экспорт', 'Export')}</button>
                <button className="secondary compact" disabled={account.protocol === 'tox' && !toxAvailable} title={account.protocol === 'tox' && !toxAvailable ? languageHint(t, 'Шлюз Tox не настроен.', 'The Tox gateway is not configured.') : undefined} onClick={() => accountConnectionRunning(account) ? void disconnectAccount(account) : account.protocol === 'xmpp' ? connectXmpp(account) : void connectTox(account).catch(() => undefined)}>{account.protocol === 'tox' && !toxAvailable ? languageHint(t, 'Нет сети', 'No network') : account.presence === 'online' ? languageHint(t, 'Отключить', 'Disconnect') : accountConnectionRunning(account) ? languageHint(t, 'Отменить', 'Cancel') : account.connectionState === 'error' ? languageHint(t, 'Повторить', 'Retry') : languageHint(t, 'Подключить', 'Connect')}</button>
                <button className="icon-danger" onClick={() => { if (window.confirm(languageHint(t, `Удалить «${account.alias}»?`, `Remove “${account.alias}”?`))) void removeAccount(account); }} aria-label={languageHint(t, 'Удалить аккаунт', 'Remove account')}>×</button>
              </div>
            </div>
          ))}
          {profile.accounts.length === 0 && <EmptyState title={languageHint(t, 'Аккаунтов пока нет', 'No accounts yet')} text={languageHint(t, 'Выберите XMPP или Tox, чтобы начать.', 'Choose XMPP or Tox to get started.')}/>}
        </div>
        {context.menu && (() => { const account = context.menu.value; const running = accountConnectionRunning(account); return <ContextMenu state={context.menu} onClose={context.close} items={[
          { label: languageHint(t, 'Копировать адрес', 'Copy address'), disabled: !account.address, action: () => navigator.clipboard.writeText(account.address) },
          { label: languageHint(t, 'Экспорт аккаунта', 'Export account'), action: () => exportAccount(account) },
          { label: running ? languageHint(t, 'Отключить', 'Disconnect') : languageHint(t, 'Подключить', 'Connect'), action: () => running ? disconnectAccount(account) : account.protocol === 'xmpp' ? connectXmpp(account) : connectTox(account).then(() => undefined) },
          { label: languageHint(t, 'Удалить аккаунт', 'Delete account'), danger: true, action: () => { if (window.confirm(languageHint(t, `Удалить «${account.alias}»?`, `Remove “${account.alias}”?`))) return removeAccount(account); } },
        ]}/>; })()}
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

function Contacts({ profile, acceptToxFriend, rejectToxFriend, addXmppContact, addToxFriend, openContact, renameContact, deleteContact, goToAccounts, t }: { profile: LocalProfile; acceptToxFriend: (requestId: string) => Promise<void>; rejectToxFriend: (requestId: string) => Promise<void>; addXmppContact: (accountId: string, address: string, alias: string) => Promise<string>; addToxFriend: (accountId: string, address: string, message: string) => Promise<string>; openContact: (contactId: string) => Promise<void>; renameContact: (contactId: string, name: string) => Promise<void>; deleteContact: (contactId: string) => Promise<void>; goToAccounts: () => void; t: typeof copy[Language] }) {
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
  return <div className="content-grid contacts-grid"><section><PageTitle index="03" title={t.contacts} subtitle={profile.name}/>{profile.friendRequests.length > 0 && <section className="friend-requests"><h2>{languageHint(t, 'Запросы', 'Requests')}</h2>{profile.friendRequests.map((request) => <article key={request.id}><span className="chat-avatar"><ToxIcon/></span><span><strong>Tox {request.publicKey.slice(0, 8)}</strong><small>{request.message || languageHint(t, 'Хочет добавить вас', 'Wants to add you')}</small></span><div className="request-actions"><button className="primary compact" onClick={() => void acceptToxFriend(request.id)}>{languageHint(t, 'Принять', 'Accept')}</button><button className="icon-text" onClick={() => void rejectToxFriend(request.id)}>{languageHint(t, 'Отклонить', 'Decline')}</button></div></article>)}</section>}<div className={`contact-list ${profile.contacts.length === 0 ? 'is-empty' : ''}`}>{profile.contacts.map((contact) => <ContactRow key={contact.id} contact={contact} open={() => openContact(contact.id)} rename={(name) => renameContact(contact.id, name)} remove={() => deleteContact(contact.id)} t={t}/>)}{profile.contacts.length === 0 && profile.friendRequests.length === 0 && <EmptyState title={languageHint(t, 'Контактов пока нет', 'No contacts yet')} text={profile.accounts.length > 0 ? languageHint(t, 'Добавьте первый контакт справа.', 'Add your first contact on the right.') : languageHint(t, 'Сначала подключите XMPP или Tox.', 'Connect XMPP or Tox first.')}/>}</div></section><section className="form-panel contact-add-panel"><h2>{languageHint(t, 'Добавить контакт', 'Add contact')}</h2>{profile.accounts.length === 0 ? <EmptyState title={languageHint(t, 'Нет подключений', 'No connections')} text={languageHint(t, 'Добавьте аккаунт, затем возвращайтесь сюда.', 'Add an account, then return here.')}><button className="primary compact-action" onClick={goToAccounts}>{t.connectAccount}</button></EmptyState> : <><div className="protocol-picker" role="tablist" aria-label={languageHint(t, 'Протокол контакта', 'Contact protocol')}><button role="tab" aria-selected={kind === 'xmpp'} disabled={xmppAccounts.length === 0} className={kind === 'xmpp' ? 'active' : ''} onClick={() => { setKind('xmpp'); setAccountId(xmppAccounts[0]?.id ?? ''); setAddress(''); setFormError(''); }}><span className="protocol-logo xmpp-logo"><XmppIcon/></span><strong>XMPP</strong></button><button role="tab" aria-selected={kind === 'tox'} disabled={toxAccounts.length === 0} className={kind === 'tox' ? 'active' : ''} onClick={() => { setKind('tox'); setAccountId(toxAccounts[0]?.id ?? ''); setAddress(''); setFormError(''); }}><span className="protocol-logo tox-logo"><ToxIcon/></span><strong>Tox</strong></button></div><form className="connect-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}><label>{languageHint(t, 'Ваш аккаунт', 'Your account')}<select value={selectedAccountId} onChange={(event) => setAccountId(event.target.value)} required>{accounts.map((account) => <option key={account.id} value={account.id}>{account.alias}{account.presence === 'online' ? ` · ${languageHint(t, 'в сети', 'online')}` : ''}</option>)}</select></label><label>{kind === 'xmpp' ? languageHint(t, 'Адрес XMPP', 'XMPP address') : 'Tox ID'}<input type={kind === 'xmpp' ? 'email' : 'text'} value={address} onChange={(event) => setAddress(event.target.value.trim())} placeholder={kind === 'xmpp' ? 'friend@example.org' : undefined} minLength={kind === 'tox' ? 76 : undefined} maxLength={kind === 'tox' ? 76 : 320} spellCheck={false} required/></label>{kind === 'xmpp' ? <label>{languageHint(t, 'Имя в приложении', 'Name in the app')}<input value={alias} onChange={(event) => setAlias(event.target.value)} maxLength={128} placeholder={languageHint(t, 'Необязательно', 'Optional')}/></label> : <label>{languageHint(t, 'Сообщение-знакомство', 'Introduction message')}<input value={message} onChange={(event) => setMessage(event.target.value)} maxLength={500}/></label>}<button className="primary" type="submit" disabled={submitting || !selectedAccountId}>{submitting ? languageHint(t, 'Добавляем…', 'Adding…') : kind === 'xmpp' ? languageHint(t, 'Добавить и открыть чат', 'Add and open chat') : languageHint(t, 'Отправить запрос', 'Send request')}</button>{formError && <p className="inline-error" role="alert">{formError}</p>}</form></>}</section></div>;
}

function ContactRow({ contact, open, rename, remove, t }: { contact: Contact; open: () => Promise<void>; rename: (name: string) => Promise<void>; remove: () => Promise<void>; t: typeof copy[Language] }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(contact.alias);
  const [saving, setSaving] = useState(false);
  const context = useContextMenu<Contact>();
  useEffect(() => { if (!editing) setName(contact.alias); }, [contact.alias, editing]);
  const save = async () => {
    const next = name.trim();
    if (!next || next === contact.alias) { setEditing(false); setName(contact.alias); return; }
    setSaving(true);
    try { await rename(next); setEditing(false); }
    finally { setSaving(false); }
  };
  if (editing) return <div className="contact-row editing"><span className={`chat-avatar ${contact.protocol}`}>{contact.protocol === 'tox' ? <ToxIcon/> : <XmppIcon/>}</span><form className="contact-rename-form" onSubmit={(event) => { event.preventDefault(); void save(); }}><input autoFocus value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { setName(contact.alias); setEditing(false); } }} maxLength={128} aria-label={languageHint(t, 'Имя контакта', 'Contact name')}/><div><button type="button" className="contact-edit-button" onClick={() => { setName(contact.alias); setEditing(false); }} aria-label={languageHint(t, 'Отмена', 'Cancel')}><CancelIcon/></button><button type="submit" className="contact-edit-button save" disabled={saving || !name.trim()} aria-label={languageHint(t, 'Сохранить имя', 'Save name')}><DeliveredIcon/></button></div></form></div>;
  return <div className="contact-row" onContextMenu={(event) => context.open(event, contact)}><button className="contact-open" onClick={() => void open()} title={languageHint(t, 'ПКМ — действия с контактом', 'Right-click for contact actions')}><span className={`chat-avatar ${contact.protocol}`}>{contact.protocol === 'tox' ? <ToxIcon/> : <XmppIcon/>}</span><span className="contact-copy"><strong>{contact.alias}</strong><small>{contact.address}</small></span><span className="contact-tail"><span className={`presence-dot ${contact.presence}`}/><small>{presenceLabel(contact.presence, t)}</small><ArrowIcon/></span></button><button className="contact-edit-button" onClick={() => setEditing(true)} aria-label={languageHint(t, `Переименовать ${contact.alias}`, `Rename ${contact.alias}`)} title={languageHint(t, 'Переименовать', 'Rename')}><EditIcon/></button>{context.menu && <ContextMenu state={context.menu} onClose={context.close} items={[
    { label: languageHint(t, 'Открыть чат', 'Open chat'), action: open },
    { label: contact.protocol === 'tox' ? 'Копировать Tox ID' : languageHint(t, 'Копировать JID', 'Copy JID'), action: () => navigator.clipboard.writeText(contact.address) },
    { label: languageHint(t, 'Переименовать', 'Rename'), action: () => setEditing(true) },
    { label: languageHint(t, 'Удалить контакт', 'Delete contact'), danger: true, action: () => { if (window.confirm(languageHint(t, `Удалить контакт «${contact.alias}» и локальную историю?`, `Delete “${contact.alias}” and local history?`))) return remove(); } },
  ]}/>}</div>;
}

function Privacy({ data, profile, network, t, onLock, onWipe, onExport }: { data: VaultData; profile: LocalProfile; network: NetworkActivity[]; t: typeof copy[Language]; onLock: () => void; onWipe: () => Promise<void>; onExport: () => Promise<void> }) {
  const messageCount = data.profiles.reduce((count, item) => count + item.messages.length, 0);
  return <div className="single-page privacy-page"><PageTitle index="04" title={t.privacy} subtitle={profile.name}/><section className="summary-list"><div><span>{languageHint(t, 'Сообщения на устройстве', 'Messages on device')}</span><strong>{messageCount}</strong></div><div><span>{t.currentConnections}</span><strong>{network.filter((item) => item.state === 'open').length}</strong></div></section><p className="simple-notice">{languageHint(t, 'Хранилище, пароли, OMEMO-ключи и история остаются в зашифрованном виде на этом устройстве. Аналитики и трекеров нет. GitHub видит обычные данные веб-запроса (например IP и время), выбранный XMPP-сервер — JID и метаданные доставки, а Cloudflare Tox-шлюз — IP, время и объём зашифрованного трафика. Содержимое Tox и OMEMO-сообщений этим посредникам недоступно.', 'The vault, passwords, OMEMO keys, and history stay encrypted on this device. There are no analytics or trackers. GitHub sees ordinary web-request metadata such as IP and time, the selected XMPP server sees JIDs and delivery metadata, and the Cloudflare Tox gateway sees IP, timing, and encrypted traffic volume. These intermediaries cannot read Tox or OMEMO message content.')}</p><section className="vault-actions"><button onClick={() => void onExport()}><DownloadIcon/><span><strong>{languageHint(t, 'Скачать резервную копию', 'Download backup')}</strong><small>{languageHint(t, 'Копия защищена вашим паролем', 'Protected with your password')}</small></span><ArrowIcon/></button><button onClick={onLock}><LockIcon/><span><strong>{t.lock}</strong><small>{languageHint(t, 'Потребуется снова ввести пароль', 'You will need to enter your password again')}</small></span><ArrowIcon/></button><button className="danger" onClick={() => { if (window.confirm(t.dangerWipe)) void onWipe(); }}><span className="delete-x">×</span><span><strong>{t.wipe}</strong><small>{t.dangerWipe}</small></span><ArrowIcon/></button></section></div>;
}

function Plugins({ data, t, onInstall, onToggle, onRemove }: { data: VaultData; t: typeof copy[Language]; onInstall: (source: string, granted: PluginPermission[]) => Promise<void>; onToggle: (id: string) => Promise<void>; onRemove: (id: string) => Promise<void> }) {
  const [pending, setPending] = useState<{ source: string; name: string; description: string; permissions: PluginPermission[] }>();
  const [granted, setGranted] = useState<PluginPermission[]>([]);
  const [pluginError, setPluginError] = useState('');
  const choose = async (file?: File) => {
    if (!file) return;
    try {
      if (file.size > MAX_PLUGIN_MANIFEST_BYTES) throw new Error('Plugin manifest exceeds the 64 KiB safety limit');
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
  const importProfile = async (file?: File) => {
    if (!file) return;
    try {
      if (file.size > MAX_PROFILE_BACKUP_BYTES) throw new Error('Profile backup exceeds the 64 MiB safety limit');
      await onImportProfile(await file.text());
    } catch (reason) { window.alert(redactError(reason)); }
  };
  const setAvatar = (file?: File) => { if (!file) return; const allowed = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']); if (!allowed.has(file.type) || file.size > 512_000) { window.alert('Use a PNG, JPEG, WebP, or GIF image smaller than 500 KiB'); return; } const reader = new FileReader(); reader.onload = () => { if (typeof reader.result === 'string') void onAvatar(reader.result); }; reader.readAsDataURL(file); };
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
    if (conversation.encryption?.policy === 'force-omemo' && conversation.encryption.provider !== 'omemo') return { label: languageHint(t, 'OMEMO · выбран', 'OMEMO · selected'), tone: 'warning' };
    if (conversation.encryption?.policy === 'plaintext') return { label: languageHint(t, 'XMPP · защита TLS', 'XMPP · TLS transport'), tone: 'warning' };
  if (conversation.encryption?.provider === 'omemo' && conversation.encryption.warning === 'stale-device') return { label: languageHint(t, 'OMEMO · обновлено', 'OMEMO · refreshed'), tone: 'warning' };
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
  if (account.protocol === 'tox' && state === 'online') return languageHint(t, 'Сеть Tox подключена', 'Tox network connected');
  const labels: Record<string, [string, string]> = {
    offline: ['Не подключён', 'Offline'], starting: ['Запускается…', 'Starting…'], connecting: ['Подключение…', 'Connecting…'], authenticating: ['Вход…', 'Signing in…'], online: ['В сети', 'Online'], reconnecting: ['Переподключение…', 'Reconnecting…'], error: ['Ошибка подключения', 'Connection error'],
  };
  const [ru, en] = labels[state] ?? labels.offline!;
  return languageHint(t, ru, en);
}

function validateOutgoingMessage(protocol: Conversation['protocol'], body: string, t: typeof copy[Language]): void {
  const bytes = new TextEncoder().encode(body).byteLength;
  const maximum = protocol === 'tox' ? TOX_MESSAGE_MAX_BYTES : XMPP_MESSAGE_MAX_BYTES;
  if (bytes > maximum) {
    throw new Error(languageHint(t, protocol === 'tox' ? 'Сообщение Tox слишком длинное. Разделите его на несколько сообщений.' : 'Сообщение слишком длинное. Разделите его на несколько сообщений.', protocol === 'tox' ? 'The Tox message is too long. Split it into several messages.' : 'The message is too long. Split it into several messages.'));
  }
}

function isOmemoUnavailableError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'OmemoUnavailableError';
}

async function requestDurableStorage(): Promise<void> {
  try { await navigator.storage?.persist?.(); } catch { /* The browser can safely decline persistent storage. */ }
}
function languageHint(t: typeof copy[Language], ru: string, en: string) { return t === copy.ru ? ru : en; }
function bareAddress(jid: string): string { return jid.split('/', 1)[0] ?? jid; }
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
function downloadText(value: string, filename: string) { const url = URL.createObjectURL(new Blob([value], { type: 'application/json' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
function safeFilename(value: string) { return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'profile'; }
