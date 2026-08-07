import {
  InMemoryStore,
  KeyHelper,
  OMEMOAddress,
  SessionBuilder,
  SessionCipher,
  curvePubKeyToEd25519PubKey,
  type KeyPair,
  type OMEMOVersion,
  type PreKeyBundle,
} from 'libomemo.js';
import type { OmemoAccountState, OmemoStoredValue } from '../models/types';
import { XmppIqError, type XmppClient, type XmppOmemoNamespace, type XmppOmemoPayload } from '../protocols/xmpp/client';
import { escapeXml, firstDescendant, parseXmppElement } from '../protocols/xmpp/xml';
import { base64ToBytes, bytesToBase64, decodeUtf8, randomBytes, toArrayBuffer, utf8 } from '../security/encoding';

const OMEMO_NS = 'urn:xmpp:omemo:2' as const;
const LEGACY_NS = 'eu.siacs.conversations.axolotl' as const;
const DEVICES_NODE = `${OMEMO_NS}:devices`;
const BUNDLES_NODE = `${OMEMO_NS}:bundles`;
const LEGACY_DEVICES_NODE = `${LEGACY_NS}.devicelist`;
const LEGACY_BUNDLES_NODE = `${LEGACY_NS}.bundles`;
const PUBSUB_NS = 'http://jabber.org/protocol/pubsub';
const PUBSUB_OWNER_NS = 'http://jabber.org/protocol/pubsub#owner';
const PREKEY_TARGET = 100;
const MAX_REMOTE_DEVICES = 100;
const MAX_OMEMO_PAYLOAD_BYTES = 256 * 1024;
const CACHE_TTL_MS = 5 * 60_000;

export interface OmemoEncryptedMessage {
  namespace: XmppOmemoNamespace;
  xml: string;
  devices: Array<{ jid: string; deviceId: number; fingerprint: string }>;
  skippedDevices: Array<{ jid: string; deviceId: number }>;
}

export class OmemoUnavailableError extends Error {
  constructor(readonly skippedDevices: Array<{ jid: string; deviceId: number }> = []) {
    super('The contact has no reachable OMEMO devices; the message was not sent');
    this.name = 'OmemoUnavailableError';
  }
}

interface DeviceCacheEntry { expiresAt: number; ids: number[] }

export class OmemoEngine {
  private readonly store = new InMemoryStore();
  private readonly legacyStore = new InMemoryStore();
  private readonly deviceCache = new Map<string, DeviceCacheEntry>();
  private readonly subscriptions = new Set<string>();

  private constructor(
    private readonly client: XmppClient,
    readonly ownJid: string,
    private state: OmemoAccountState,
    private readonly persist: (state: OmemoAccountState) => Promise<void>,
  ) {
    this.store.store = decodeStore(state.store);
    this.legacyStore.store = decodeStore(state.legacyStore!);
    this.client.setOmemoDeviceId(state.deviceId);
  }

  static async open(
    client: XmppClient,
    jid: string,
    saved: OmemoAccountState | undefined,
    persist: (state: OmemoAccountState) => Promise<void>,
  ): Promise<OmemoEngine> {
    const ownJid = bareJid(jid);
    if (!ownJid.includes('@')) throw new Error('OMEMO requires a complete XMPP JID');
    const original = saved ? validateState(saved) : await createState();
    const { state, migrated } = await ensureLegacyState(original);
    const engine = new OmemoEngine(client, ownJid, state, persist);
    if (!saved || migrated) await engine.save();
    return engine;
  }

  get deviceId(): number { return this.state.deviceId; }

  updateDeviceList(jid: string, ids: number[], version: OMEMOVersion = OMEMO_NS): void {
    const bare = bareJid(jid);
    if (!bare.includes('@')) return;
    this.deviceCache.set(cacheKey(bare, version), {
      expiresAt: Date.now() + CACHE_TTL_MS,
      ids: [...new Set(ids.filter(validDeviceId))].slice(0, MAX_REMOTE_DEVICES),
    });
  }

  async warmup(recipientJid: string): Promise<void> {
    const recipient = bareJid(recipientJid);
    if (!recipient.includes('@')) return;
    await Promise.all([
      this.fetchDevices(recipient, OMEMO_NS, true),
      this.fetchDevices(recipient, LEGACY_NS, true),
      this.ensureDeviceSubscription(recipient, OMEMO_NS),
      this.ensureDeviceSubscription(recipient, LEGACY_NS),
    ]);
  }

  async announce(): Promise<void> {
    await Promise.all([this.replenishPreKeys(OMEMO_NS), this.replenishPreKeys(LEGACY_NS)]);
    const results = await Promise.allSettled([this.announceVersion(OMEMO_NS), this.announceVersion(LEGACY_NS)]);
    if (results.every((result) => result.status === 'rejected')) throw (results[0] as PromiseRejectedResult).reason;
  }

  async revoke(): Promise<void> {
    await Promise.allSettled([this.revokeVersion(OMEMO_NS), this.revokeVersion(LEGACY_NS)]);
    this.client.setOmemoDeviceId(undefined);
  }

  async encrypt(recipientJid: string, plaintext: string): Promise<OmemoEncryptedMessage> {
    const recipient = bareJid(recipientJid);
    if (!recipient.includes('@')) throw new Error('OMEMO recipient JID is invalid');
    void this.ensureDeviceSubscription(recipient, OMEMO_NS);
    void this.ensureDeviceSubscription(recipient, LEGACY_NS);
    let version: OMEMOVersion = OMEMO_NS;
    let remote = await this.prepareWithRefresh(recipient, version);
    if (remote.ready.length === 0) {
      version = LEGACY_NS;
      remote = await this.prepareWithRefresh(recipient, version);
    }
    if (remote.ready.length === 0) throw new OmemoUnavailableError(remote.skipped.map((deviceId) => ({ jid: recipient, deviceId })));

    const ownIds = (await this.fetchDevices(this.ownJid, version).catch(() => [])).filter((id) => id !== this.deviceId);
    const own = await this.prepareDevices(this.ownJid, ownIds, version);
    const targets = new Map<string, number[]>([[recipient, remote.ready]]);
    if (own.ready.length) targets.set(this.ownJid, own.ready);
    const skippedDevices = [
      ...remote.skipped.map((deviceId) => ({ jid: recipient, deviceId })),
      ...own.skipped.map((deviceId) => ({ jid: this.ownJid, deviceId })),
    ];

    return version === OMEMO_NS
      ? this.encryptModern(targets, plaintext, skippedDevices)
      : this.encryptLegacy(targets, plaintext, skippedDevices);
  }

  private async encryptModern(targets: Map<string, number[]>, plaintext: string, skippedDevices: OmemoEncryptedMessage['skippedDevices']): Promise<OmemoEncryptedMessage> {
    const envelope = createSceEnvelope(this.ownJid, plaintext);
    const contentKey = randomBytes(32);
    const keyMaterial = new Uint8Array(48);
    try {
      const encryptedPayload = await encryptPayload(contentKey, utf8(envelope));
      keyMaterial.set(contentKey);
      keyMaterial.set(encryptedPayload.mac, 32);
      const keyGroups: string[] = [];
      const devices: OmemoEncryptedMessage['devices'] = [];

      for (const [jid, ids] of targets) {
        const keys: string[] = [];
        for (const deviceId of ids.slice(0, MAX_REMOTE_DEVICES)) {
          const address = new OMEMOAddress(jid, deviceId);
          const cipher = new SessionCipher(this.store, address, OMEMO_NS);
          const encryptedKey = await cipher.encrypt(keyMaterial);
          const identity = await this.store.loadIdentityKey(address.toString());
          const wireKey = bytesToBase64(Uint8Array.from(encryptedKey.body, (character) => character.charCodeAt(0) & 0xff));
          keys.push(`<key rid="${deviceId}"${encryptedKey.kex ? ' kex="true"' : ''}>${wireKey}</key>`);
          devices.push({ jid, deviceId, fingerprint: identity ? fingerprint(identity) : '' });
        }
        keyGroups.push(`<keys jid="${escapeXml(jid)}">${keys.join('')}</keys>`);
      }
      await this.save();
      return {
        namespace: OMEMO_NS,
        xml: `<encrypted xmlns="${OMEMO_NS}"><header sid="${this.deviceId}">${keyGroups.join('')}</header><payload>${bytesToBase64(encryptedPayload.ciphertext)}</payload></encrypted>`,
        devices,
        skippedDevices,
      };
    } finally {
      contentKey.fill(0);
      keyMaterial.fill(0);
    }
  }

  private async encryptLegacy(targets: Map<string, number[]>, plaintext: string, skippedDevices: OmemoEncryptedMessage['skippedDevices']): Promise<OmemoEncryptedMessage> {
    const contentKey = randomBytes(16);
    const iv = randomBytes(12);
    const keyMaterial = new Uint8Array(32);
    try {
      const encryptedPayload = await encryptLegacyPayload(contentKey, iv, utf8(plaintext));
      keyMaterial.set(contentKey);
      keyMaterial.set(encryptedPayload.tag, 16);
      const keys: string[] = [];
      const devices: OmemoEncryptedMessage['devices'] = [];
      for (const [jid, ids] of targets) {
        for (const deviceId of ids.slice(0, MAX_REMOTE_DEVICES)) {
          const address = new OMEMOAddress(jid, deviceId);
          const cipher = new SessionCipher(this.legacyStore, address, LEGACY_NS);
          const encryptedKey = await cipher.encrypt(keyMaterial);
          const identity = await this.legacyStore.loadIdentityKey(address.toString());
          const wireKey = bytesToBase64(Uint8Array.from(encryptedKey.body, (character) => character.charCodeAt(0) & 0xff));
          keys.push(`<key rid="${deviceId}"${encryptedKey.type === 3 ? ' prekey="true"' : ''}>${wireKey}</key>`);
          devices.push({ jid, deviceId, fingerprint: identity ? fingerprint(identity) : '' });
        }
      }
      await this.save();
      return {
        namespace: LEGACY_NS,
        xml: `<encrypted xmlns="${LEGACY_NS}"><header sid="${this.deviceId}">${keys.join('')}<iv>${bytesToBase64(iv)}</iv></header><payload>${bytesToBase64(encryptedPayload.ciphertext)}</payload></encrypted>`,
        devices,
        skippedDevices,
      };
    } finally {
      contentKey.fill(0);
      iv.fill(0);
      keyMaterial.fill(0);
    }
  }

  async decrypt(senderJid: string, payload: XmppOmemoPayload): Promise<{ body: string; fingerprint: string }> {
    const sender = bareJid(senderJid);
    void this.warmup(sender).catch(() => undefined);
    if (payload.namespace === LEGACY_NS) return this.decryptLegacy(sender, payload);
    if (payload.namespace !== OMEMO_NS) throw new Error('Unsupported OMEMO version');
    const address = new OMEMOAddress(sender, payload.senderDeviceId);
    const cipher = new SessionCipher(this.store, address, OMEMO_NS);
    const keyResult = payload.keyExchange
      ? await cipher.decryptPreKeyWhisperMessage(payload.encryptedKey, 'base64')
      : await cipher.decryptWhisperMessage(payload.encryptedKey, 'base64');
    const keyMaterial = new Uint8Array(keyResult.plaintext);
    try {
      if (keyMaterial.byteLength !== 48) throw new Error('Invalid OMEMO content key');
      const plaintext = await decryptPayload(keyMaterial.subarray(0, 32), keyMaterial.subarray(32), base64ToBytes(payload.ciphertext));
      const envelope = parseXmppElement(decodeUtf8(toArrayBuffer(plaintext)));
      if (envelope.localName !== 'envelope' || envelope.namespaceURI !== 'urn:xmpp:sce:1') throw new Error('Invalid OMEMO SCE envelope');
      const claimedFrom = Array.from(envelope.children).find((child) => child.localName === 'from')?.getAttribute('jid');
      if (claimedFrom && bareJid(claimedFrom) !== sender) throw new Error('OMEMO sender binding failed');
      const content = Array.from(envelope.children).find((child) => child.localName === 'content');
      const body = content ? firstDescendant(content, 'body') : undefined;
      if (!body || body.namespaceURI !== 'jabber:client') throw new Error('OMEMO message has no supported body');
      const identity = await this.store.loadIdentityKey(address.toString());
      await this.replenishPreKeys(OMEMO_NS);
      if (payload.keyExchange) await this.publishBundle(OMEMO_NS);
      await this.save();
      return { body: body.textContent ?? '', fingerprint: identity ? fingerprint(identity) : '' };
    } finally {
      keyMaterial.fill(0);
    }
  }

  private async decryptLegacy(sender: string, payload: XmppOmemoPayload): Promise<{ body: string; fingerprint: string }> {
    if (!payload.iv) throw new Error('Legacy OMEMO message has no IV');
    const address = new OMEMOAddress(sender, payload.senderDeviceId);
    const cipher = new SessionCipher(this.legacyStore, address, LEGACY_NS);
    const keyResult = payload.keyExchange
      ? await cipher.decryptPreKeyWhisperMessage(payload.encryptedKey, 'base64')
      : await cipher.decryptWhisperMessage(payload.encryptedKey, 'base64');
    const keyMaterial = new Uint8Array(keyResult.plaintext);
    try {
      if (keyMaterial.byteLength < 32) throw new Error('Invalid legacy OMEMO content key');
      const body = decodeUtf8(toArrayBuffer(await decryptLegacyPayload(
        keyMaterial.subarray(0, 16), base64ToBytes(payload.iv), base64ToBytes(payload.ciphertext), keyMaterial.subarray(16),
      )));
      const identity = await this.legacyStore.loadIdentityKey(address.toString());
      await this.replenishPreKeys(LEGACY_NS);
      if (payload.keyExchange) await this.publishBundle(LEGACY_NS);
      await this.save();
      return { body, fingerprint: identity ? fingerprint(identity) : '' };
    } finally {
      keyMaterial.fill(0);
    }
  }

  exportState(): OmemoAccountState {
    return { ...this.state, store: encodeStore(this.store.store), legacyStore: encodeStore(this.legacyStore.store) };
  }

  private async prepareWithRefresh(jid: string, version: OMEMOVersion): Promise<{ ready: number[]; skipped: number[] }> {
    let ids = await this.fetchDevices(jid, version);
    if (ids.length === 0) ids = await this.fetchDevices(jid, version, true);
    let result = await this.prepareDevices(jid, ids, version);
    if (result.ready.length === 0 && result.skipped.length > 0) {
      ids = await this.fetchDevices(jid, version, true);
      result = await this.prepareDevices(jid, ids, version);
    }
    return result;
  }

  private async fetchDevices(jid: string, version: OMEMOVersion, bypassCache = false): Promise<number[]> {
    const bare = bareJid(jid);
    const key = cacheKey(bare, version);
    const cached = this.deviceCache.get(key);
    if (!bypassCache && cached && cached.expiresAt > Date.now()) return [...cached.ids];
    const node = version === OMEMO_NS ? DEVICES_NODE : LEGACY_DEVICES_NODE;
    const requestedItem = version === OMEMO_NS ? '<item id="current"/>' : '';
    let iq: Element;
    try {
      iq = await this.client.requestIq(
        `<pubsub xmlns="${PUBSUB_NS}"><items node="${node}">${requestedItem}</items></pubsub>`,
        { to: bare },
      );
    } catch (error) {
      if (!(error instanceof XmppIqError) || error.condition !== 'item-not-found') throw error;
      this.deviceCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, ids: [] });
      return [];
    }
    const devices = Array.from(iq.getElementsByTagNameNS(version, 'device'))
      .map((element) => Number(element.getAttribute('id')))
      .filter(validDeviceId);
    const ids = [...new Set(devices)].slice(0, MAX_REMOTE_DEVICES);
    this.deviceCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, ids });
    return ids;
  }

  private async prepareDevices(jid: string, ids: number[], version: OMEMOVersion): Promise<{ ready: number[]; skipped: number[] }> {
    const bare = bareJid(jid);
    const store = this.storeFor(version);
    const results = await Promise.all(ids.slice(0, MAX_REMOTE_DEVICES).map(async (deviceId) => {
      const address = new OMEMOAddress(bare, deviceId);
      const cipher = new SessionCipher(store, address, version);
      if (await cipher.hasOpenSession()) return { deviceId, ready: true as const };
      try {
        const bundle = await this.fetchBundle(bare, deviceId, version);
        await new SessionBuilder(store, address, version).processPreKey(bundle);
        return { deviceId, ready: true as const };
      } catch (error) {
        if (isSkippableBundleError(error)) return { deviceId, ready: false as const };
        throw error;
      }
    }));
    const ready = results.filter((result) => result.ready).map((result) => result.deviceId);
    const skipped = results.filter((result) => !result.ready).map((result) => result.deviceId);
    if (ready.length) await this.save();
    return { ready, skipped };
  }

  private async ensureDeviceSubscription(jid: string, version: OMEMOVersion): Promise<void> {
    const bare = bareJid(jid);
    const key = cacheKey(bare, version);
    if (bare === this.ownJid || this.subscriptions.has(key)) return;
    const node = version === OMEMO_NS ? DEVICES_NODE : LEGACY_DEVICES_NODE;
    try {
      await this.client.requestIq(
        `<pubsub xmlns="${PUBSUB_NS}"><subscribe node="${node}" jid="${escapeXml(this.ownJid)}"/></pubsub>`,
        { type: 'set', to: bare },
      );
      this.subscriptions.add(key);
    } catch {
      // Presence-based PEP notifications or a fresh fetch on chat focus remain available.
    }
  }

  private async fetchBundle(jid: string, deviceId: number, version: OMEMOVersion): Promise<PreKeyBundle> {
    const node = version === OMEMO_NS ? BUNDLES_NODE : `${LEGACY_BUNDLES_NODE}:${deviceId}`;
    const item = version === OMEMO_NS ? `<item id="${deviceId}"/>` : '';
    const iq = await this.client.requestIq(
      `<pubsub xmlns="${PUBSUB_NS}"><items node="${node}">${item}</items></pubsub>`,
      { to: bareJid(jid) },
    );
    const bundle = iq.getElementsByTagNameNS(version, 'bundle')[0];
    if (!bundle) throw new Error(`OMEMO bundle is unavailable for device ${deviceId}`);
    const modern = version === OMEMO_NS;
    const ik = requiredChildBytes(bundle, modern ? 'ik' : 'identityKey', modern ? 32 : 33, modern ? 32 : 33, version);
    const spk = requiredChild(bundle, modern ? 'spk' : 'signedPreKeyPublic', version);
    const spks = requiredChildBytes(bundle, modern ? 'spks' : 'signedPreKeySignature', 64, 64, version);
    const prekeys = Array.from(bundle.getElementsByTagNameNS(version, modern ? 'pk' : 'preKeyPublic'));
    if (prekeys.length === 0 || prekeys.length > 200) throw new Error('OMEMO bundle has an unsafe PreKey count');
    const chosen = prekeys[crypto.getRandomValues(new Uint32Array(1))[0]! % prekeys.length]!;
    return {
      registrationId: deviceId,
      identityKey: toArrayBuffer(ik),
      signedPreKey: {
        keyId: positiveId(spk.getAttribute(modern ? 'id' : 'signedPreKeyId')),
        publicKey: toArrayBuffer(sizedElementBytes(spk, modern ? 32 : 33, modern ? 32 : 33)),
        signature: toArrayBuffer(spks),
      },
      preKey: {
        keyId: positiveId(chosen.getAttribute(modern ? 'id' : 'preKeyId')),
        publicKey: toArrayBuffer(sizedElementBytes(chosen, modern ? 32 : 33, modern ? 32 : 33)),
      },
    };
  }

  private async announceVersion(version: OMEMOVersion): Promise<void> {
    let devices: number[] = [];
    try { devices = await this.fetchDevices(this.ownJid, version, true); } catch { /* a new PEP node has no item yet */ }
    if (!devices.includes(this.deviceId)) devices.push(this.deviceId);
    const normalized = [...new Set(devices)].slice(0, MAX_REMOTE_DEVICES);
    const deviceXml = normalized.map((id) => `<device id="${id}"/>`).join('');
    await this.publishDeviceList(deviceXml, version);
    await this.publishBundle(version);
    this.deviceCache.set(cacheKey(this.ownJid, version), { expiresAt: Date.now() + CACHE_TTL_MS, ids: normalized });
  }

  private async revokeVersion(version: OMEMOVersion): Promise<void> {
    const devices = (await this.fetchDevices(this.ownJid, version, true)).filter((id) => id !== this.deviceId);
    await this.publishDeviceList(devices.map((id) => `<device id="${id}"/>`).join(''), version);
    const node = version === OMEMO_NS ? BUNDLES_NODE : `${LEGACY_BUNDLES_NODE}:${this.deviceId}`;
    const itemId = version === OMEMO_NS ? String(this.deviceId) : '1';
    await this.client.requestIq(
      `<pubsub xmlns="${PUBSUB_NS}"><retract node="${node}" notify="true"><item id="${itemId}"/></retract></pubsub>`,
      { type: 'set' },
    );
  }

  private async publishBundle(version: OMEMOVersion): Promise<void> {
    const modern = version === OMEMO_NS;
    const store = this.storeFor(version);
    const signedPreKeyId = modern ? this.state.signedPreKeyId : this.state.legacySignedPreKeyId!;
    const signature = modern ? this.state.signedPreKeySignature : this.state.legacySignedPreKeySignature!;
    const identity = await store.getIdentityKeyPair();
    const signed = await store.loadSignedPreKey(signedPreKeyId);
    if (!identity || !signed) throw new Error('Local OMEMO keys are incomplete');
    const prekeys = Object.entries(store.store)
      .filter(([key]) => key.startsWith('25519KeypreKey'))
      .slice(0, PREKEY_TARGET)
      .map(([key, value]) => {
        const id = positiveId(key.slice('25519KeypreKey'.length));
        const pair = value as KeyPair;
        return modern
          ? `<pk id="${id}">${bytesToBase64(wireCurvePublicKey(pair.pubKey))}</pk>`
          : `<preKeyPublic preKeyId="${id}">${bytesToBase64(new Uint8Array(pair.pubKey))}</preKeyPublic>`;
      });
    if (prekeys.length < 25) throw new Error('Local OMEMO bundle has too few PreKeys');
    const identityEd = modern ? await curvePubKeyToEd25519PubKey(identity.pubKey) : undefined;
    const bundle = modern
      ? `<bundle xmlns="${OMEMO_NS}"><spk id="${signedPreKeyId}">${bytesToBase64(wireCurvePublicKey(signed.keyPair.pubKey))}</spk>` +
        `<spks>${escapeXml(signature)}</spks><ik>${bytesToBase64(new Uint8Array(identityEd!))}</ik><prekeys>${prekeys.join('')}</prekeys></bundle>`
      : `<bundle xmlns="${LEGACY_NS}"><signedPreKeyPublic signedPreKeyId="${signedPreKeyId}">${bytesToBase64(new Uint8Array(signed.keyPair.pubKey))}</signedPreKeyPublic>` +
        `<signedPreKeySignature>${escapeXml(signature)}</signedPreKeySignature><identityKey>${bytesToBase64(new Uint8Array(identity.pubKey))}</identityKey><prekeys>${prekeys.join('')}</prekeys></bundle>`;
    const node = modern ? BUNDLES_NODE : `${LEGACY_BUNDLES_NODE}:${this.deviceId}`;
    const itemId = modern ? String(this.deviceId) : '1';
    const options: Array<[string, string]> = modern
      ? [['pubsub#max_items', 'max'], ['pubsub#access_model', 'open'], ['pubsub#persist_items', '1']]
      : [['pubsub#max_items', '1'], ['pubsub#access_model', 'open'], ['pubsub#persist_items', '1']];
    const publish = () => this.client.requestIq(
      `<pubsub xmlns="${PUBSUB_NS}"><publish node="${node}"><item id="${itemId}">${bundle}</item></publish>` + publishOptions(options) + `</pubsub>`,
      { type: 'set' },
    );
    try { await publish(); }
    catch (error) {
      if (!(error instanceof XmppIqError) || !['conflict', 'not-acceptable', 'precondition-not-met'].includes(error.condition ?? '')) throw error;
      await this.configureNode(node, options);
      await publish();
    }
  }

  private async publishDeviceList(deviceXml: string, version: OMEMOVersion): Promise<void> {
    const modern = version === OMEMO_NS;
    const node = modern ? DEVICES_NODE : LEGACY_DEVICES_NODE;
    const list = modern ? `<devices xmlns="${OMEMO_NS}">${deviceXml}</devices>` : `<list xmlns="${LEGACY_NS}">${deviceXml}</list>`;
    const publish = () => this.client.requestIq(
      `<pubsub xmlns="${PUBSUB_NS}"><publish node="${node}"><item id="current">${list}</item></publish>` +
      publishOptions([['pubsub#access_model', 'open'], ['pubsub#persist_items', '1']]) + `</pubsub>`,
      { type: 'set' },
    );
    try { await publish(); }
    catch (error) {
      if (!(error instanceof XmppIqError) || !['conflict', 'not-acceptable', 'precondition-not-met'].includes(error.condition ?? '')) throw error;
      await this.configureNode(node, [['pubsub#max_items', '1'], ['pubsub#access_model', 'open'], ['pubsub#persist_items', '1']]);
      await publish();
    }
  }

  private async configureNode(node: string, configuration: Array<[string, string]>): Promise<void> {
    const fields = configuration.map(([name, value]) => `<field var="${name}"><value>${value}</value></field>`).join('');
    await this.client.requestIq(
      `<pubsub xmlns="${PUBSUB_OWNER_NS}"><configure node="${node}"><x xmlns="jabber:x:data" type="submit"><field var="FORM_TYPE" type="hidden"><value>http://jabber.org/protocol/pubsub#node_config</value></field>${fields}</x></configure></pubsub>`,
      { type: 'set' },
    );
  }

  private async replenishPreKeys(version: OMEMOVersion): Promise<void> {
    const store = this.storeFor(version);
    const present = new Set(Object.keys(store.store)
      .filter((key) => key.startsWith('25519KeypreKey'))
      .map((key) => Number(key.slice('25519KeypreKey'.length))));
    while (present.size < PREKEY_TARGET) {
      const id = randomPositiveId();
      if (present.has(id)) continue;
      const key = await KeyHelper.generatePreKey(id);
      store.storePreKey(id, key.keyPair);
      present.add(id);
    }
  }

  private async save(): Promise<void> {
    this.state = this.exportState();
    await this.persist(structuredClone(this.state));
  }

  private storeFor(version: OMEMOVersion): InMemoryStore {
    return version === OMEMO_NS ? this.store : this.legacyStore;
  }
}

async function createState(): Promise<OmemoAccountState> {
  const store = new InMemoryStore();
  const deviceId = randomPositiveId();
  const identity = await KeyHelper.generateIdentityKeyPair();
  const signedPreKeyId = randomPositiveId();
  const signed = await KeyHelper.generateSignedPreKey(identity, signedPreKeyId, OMEMO_NS);
  store.put('registrationId', deviceId);
  store.put('identityKey', identity);
  store.storeSignedPreKey(signedPreKeyId, signed.keyPair);
  const prekeyIds = new Set<number>();
  while (prekeyIds.size < PREKEY_TARGET) {
    const id = randomPositiveId();
    if (prekeyIds.has(id)) continue;
    const prekey = await KeyHelper.generatePreKey(id);
    store.storePreKey(prekey.keyId, prekey.keyPair);
    prekeyIds.add(id);
  }
  return {
    version: 1, deviceId, signedPreKeyId,
    signedPreKeySignature: bytesToBase64(new Uint8Array(signed.signature)),
    store: encodeStore(store.store),
  };
}

async function ensureLegacyState(state: OmemoAccountState): Promise<{ state: OmemoAccountState; migrated: boolean }> {
  if (state.legacyStore && state.legacySignedPreKeyId && state.legacySignedPreKeySignature) return { state, migrated: false };
  const store = new InMemoryStore();
  const identity = await KeyHelper.generateIdentityKeyPair();
  const signedPreKeyId = randomPositiveId();
  const signed = await KeyHelper.generateSignedPreKey(identity, signedPreKeyId, LEGACY_NS);
  store.put('registrationId', state.deviceId);
  store.put('identityKey', identity);
  store.storeSignedPreKey(signedPreKeyId, signed.keyPair);
  const ids = new Set<number>();
  while (ids.size < PREKEY_TARGET) {
    const id = randomPositiveId();
    if (ids.has(id)) continue;
    const prekey = await KeyHelper.generatePreKey(id);
    store.storePreKey(prekey.keyId, prekey.keyPair);
    ids.add(id);
  }
  return {
    migrated: true,
    state: {
      ...state,
      legacySignedPreKeyId: signedPreKeyId,
      legacySignedPreKeySignature: bytesToBase64(new Uint8Array(signed.signature)),
      legacyStore: encodeStore(store.store),
    },
  };
}

function validateState(state: OmemoAccountState): OmemoAccountState {
  if (state.version !== 1 || !validDeviceId(state.deviceId) || !validDeviceId(state.signedPreKeyId)) throw new Error('Invalid local OMEMO state');
  const signature = base64ToBytes(state.signedPreKeySignature);
  if (signature.byteLength !== 64) throw new Error('Invalid local OMEMO signature');
  if (!state.store || Object.keys(state.store).length > 10_000) throw new Error('Invalid local OMEMO store');
  decodeStore(state.store);
  const hasLegacy = state.legacyStore !== undefined || state.legacySignedPreKeyId !== undefined || state.legacySignedPreKeySignature !== undefined;
  if (hasLegacy) {
    if (!state.legacyStore || !validDeviceId(state.legacySignedPreKeyId ?? 0) || !state.legacySignedPreKeySignature) throw new Error('Invalid legacy OMEMO state');
    if (base64ToBytes(state.legacySignedPreKeySignature).byteLength !== 64 || Object.keys(state.legacyStore).length > 10_000) throw new Error('Invalid legacy OMEMO state');
    decodeStore(state.legacyStore);
  }
  return structuredClone(state);
}

function encodeStore(store: Record<string | number, unknown>): Record<string, OmemoStoredValue> {
  const encoded: Record<string, OmemoStoredValue> = {};
  for (const [key, value] of Object.entries(store)) {
    if (typeof value === 'number' && Number.isSafeInteger(value)) encoded[key] = { kind: 'number', value };
    else if (typeof value === 'string') encoded[key] = { kind: 'text', value };
    else if (value instanceof ArrayBuffer) encoded[key] = { kind: 'bytes', value: bytesToBase64(new Uint8Array(value)) };
    else if (isKeyPair(value)) encoded[key] = {
      kind: 'keypair', publicKey: bytesToBase64(new Uint8Array(value.pubKey)), privateKey: bytesToBase64(new Uint8Array(value.privKey)),
    };
    else throw new Error(`Unsupported OMEMO store value: ${key}`);
  }
  return encoded;
}

function decodeStore(store: Record<string, OmemoStoredValue>): Record<string, unknown> {
  const decoded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(store)) {
    if (key.length > 512) throw new Error('Invalid OMEMO store key');
    if (value.kind === 'number') decoded[key] = value.value;
    else if (value.kind === 'text') decoded[key] = value.value;
    else if (value.kind === 'bytes') decoded[key] = toArrayBuffer(base64ToBytes(value.value));
    else if (value.kind === 'keypair') decoded[key] = {
      pubKey: toArrayBuffer(base64ToBytes(value.publicKey)), privKey: toArrayBuffer(base64ToBytes(value.privateKey)),
    } satisfies KeyPair;
    else throw new Error('Invalid OMEMO store value');
  }
  return decoded;
}

async function encryptPayload(key: Uint8Array, plaintext: Uint8Array): Promise<{ ciphertext: Uint8Array; mac: Uint8Array }> {
  if (plaintext.byteLength > MAX_OMEMO_PAYLOAD_BYTES) throw new Error('OMEMO payload is too large');
  const material = await derivePayloadMaterial(key);
  const aesKey = await crypto.subtle.importKey('raw', toArrayBuffer(material.subarray(0, 32)), 'AES-CBC', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: toArrayBuffer(material.subarray(64, 80)) }, aesKey, toArrayBuffer(plaintext)));
  const hmacKey = await crypto.subtle.importKey('raw', toArrayBuffer(material.subarray(32, 64)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, toArrayBuffer(ciphertext))).slice(0, 16);
  material.fill(0);
  return { ciphertext, mac };
}

async function decryptPayload(key: Uint8Array, expectedMac: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
  if (ciphertext.byteLength < 16 || ciphertext.byteLength > MAX_OMEMO_PAYLOAD_BYTES) throw new Error('Invalid OMEMO payload size');
  const material = await derivePayloadMaterial(key);
  const hmacKey = await crypto.subtle.importKey('raw', toArrayBuffer(material.subarray(32, 64)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const actualMac = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, toArrayBuffer(ciphertext)));
  let difference = expectedMac.byteLength === 16 ? 0 : 1;
  for (let index = 0; index < 16; index += 1) difference |= (actualMac[index] ?? 0) ^ (expectedMac[index] ?? 0);
  if (difference !== 0) { material.fill(0); throw new Error('OMEMO payload authentication failed'); }
  const aesKey = await crypto.subtle.importKey('raw', toArrayBuffer(material.subarray(0, 32)), 'AES-CBC', false, ['decrypt']);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: toArrayBuffer(material.subarray(64, 80)) }, aesKey, toArrayBuffer(ciphertext)));
  } finally { material.fill(0); }
}

async function encryptLegacyPayload(key: Uint8Array, iv: Uint8Array, plaintext: Uint8Array): Promise<{ ciphertext: Uint8Array; tag: Uint8Array }> {
  if (key.byteLength !== 16 || iv.byteLength !== 12 || plaintext.byteLength > MAX_OMEMO_PAYLOAD_BYTES) throw new Error('Invalid legacy OMEMO payload');
  const aesKey = await crypto.subtle.importKey('raw', toArrayBuffer(key), 'AES-GCM', false, ['encrypt']);
  const output = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv), tagLength: 128 }, aesKey, toArrayBuffer(plaintext)));
  return { ciphertext: output.slice(0, -16), tag: output.slice(-16) };
}

async function decryptLegacyPayload(key: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array, tag: Uint8Array): Promise<Uint8Array> {
  if (key.byteLength !== 16 || iv.byteLength !== 12 || tag.byteLength !== 16 || ciphertext.byteLength > MAX_OMEMO_PAYLOAD_BYTES) throw new Error('Invalid legacy OMEMO payload');
  const combined = new Uint8Array(ciphertext.byteLength + tag.byteLength);
  combined.set(ciphertext);
  combined.set(tag, ciphertext.byteLength);
  const aesKey = await crypto.subtle.importKey('raw', toArrayBuffer(key), 'AES-GCM', false, ['decrypt']);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv), tagLength: 128 }, aesKey, toArrayBuffer(combined)));
  } finally {
    combined.fill(0);
  }
}

async function derivePayloadMaterial(key: Uint8Array): Promise<Uint8Array> {
  const hkdf = await crypto.subtle.importKey('raw', toArrayBuffer(key), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({
    name: 'HKDF', hash: 'SHA-256', salt: new ArrayBuffer(32), info: toArrayBuffer(utf8('OMEMO Payload')),
  }, hkdf, 640));
}

function createSceEnvelope(from: string, body: string): string {
  const paddingLength = 32 + (crypto.getRandomValues(new Uint8Array(1))[0]! % 96);
  const padding = bytesToBase64(randomBytes(paddingLength));
  return `<envelope xmlns="urn:xmpp:sce:1"><content><body xmlns="jabber:client">${escapeXml(body)}</body></content><rpad>${padding}</rpad><from jid="${escapeXml(from)}"/></envelope>`;
}

function publishOptions(fields: Array<[string, string]>): string {
  const values = fields.map(([name, value]) => `<field var="${name}"><value>${value}</value></field>`).join('');
  return `<publish-options><x xmlns="jabber:x:data" type="submit"><field var="FORM_TYPE" type="hidden"><value>http://jabber.org/protocol/pubsub#publish-options</value></field>${values}</x></publish-options>`;
}

function isSkippableBundleError(error: unknown): boolean {
  if (error instanceof XmppIqError) {
    return ['item-not-found', 'gone'].includes(error.condition ?? '');
  }
  return error instanceof Error && (
    error.message.startsWith('OMEMO bundle is unavailable for device ') ||
    error.message.startsWith('OMEMO bundle is missing ') ||
    error.message.startsWith('Invalid OMEMO ')
  );
}

function requiredChild(parent: Element, name: string, version: OMEMOVersion = OMEMO_NS): Element {
  const child = parent.getElementsByTagNameNS(version, name)[0];
  if (!child) throw new Error(`OMEMO bundle is missing ${name}`);
  return child;
}

function requiredChildBytes(parent: Element, name: string, min: number, max: number, version: OMEMOVersion = OMEMO_NS): Uint8Array {
  return sizedElementBytes(requiredChild(parent, name, version), min, max);
}

function sizedElementBytes(element: Element, min: number, max: number): Uint8Array {
  const bytes = base64ToBytes(element.textContent?.trim() ?? '');
  if (bytes.byteLength < min || bytes.byteLength > max) throw new Error(`Invalid OMEMO ${element.localName} size`);
  return bytes;
}

function fingerprint(key: ArrayBuffer): string {
  return Array.from(new Uint8Array(key), (byte) => byte.toString(16).padStart(2, '0')).join('').match(/.{1,8}/g)?.join(' ') ?? '';
}

function isKeyPair(value: unknown): value is KeyPair {
  if (!value || typeof value !== 'object') return false;
  const pair = value as Partial<KeyPair>;
  return pair.pubKey instanceof ArrayBuffer && pair.privKey instanceof ArrayBuffer;
}

function wireCurvePublicKey(key: ArrayBuffer): Uint8Array {
  const bytes = new Uint8Array(key);
  if (bytes.byteLength !== 33 || bytes[0] !== 5) throw new Error('Invalid local OMEMO public key');
  return bytes.slice(1);
}

function randomPositiveId(): number {
  return (crypto.getRandomValues(new Uint32Array(1))[0]! & 0x7fffffff) || 1;
}

function positiveId(value: string | null): number {
  const id = Number(value);
  if (!validDeviceId(id)) throw new Error('Invalid OMEMO key identifier');
  return id;
}

function validDeviceId(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 0x7fffffff;
}

function cacheKey(jid: string, version: OMEMOVersion): string { return `${version}\u0000${bareJid(jid)}`; }

function bareJid(jid: string): string { return jid.split('/')[0] ?? jid; }
