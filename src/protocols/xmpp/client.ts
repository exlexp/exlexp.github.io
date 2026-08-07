import { networkPolicy } from '../../network/policy';
import { bytesToBase64, utf8 } from '../../security/encoding';
import { redactError } from '../../security/redaction';
import { createScramSession, decodeSasl, encodeSasl, verifyServerFinal, type ScramSession } from './scram';
import { descendants, escapeXml, firstDescendant, parseXmppElement, textOf } from './xml';
import { XmppStreamManager } from './streamManagement';

export interface XmppCredentials {
  jid: string;
  password: string;
  endpoint: string;
  resource?: string;
  restoreArchive?: boolean;
}

export type XmppState = 'offline' | 'connecting' | 'authenticating' | 'online' | 'reconnecting' | 'error';
export type XmppOmemoNamespace = 'urn:xmpp:omemo:2' | 'eu.siacs.conversations.axolotl';

export type XmppEvent =
  | { type: 'state'; state: XmppState; detail?: string }
  | { type: 'message'; id: string; from: string; body: string; timestamp: number; direction: 'incoming' | 'outgoing'; archived?: boolean }
  | { type: 'encrypted-message'; id: string; from: string; timestamp: number; archived?: boolean; payload: XmppOmemoPayload }
  | { type: 'receipt'; id: string; from: string }
  | { type: 'message-error'; id: string; from: string; detail: string }
  | { type: 'presence'; from: string; show: string }
  | { type: 'chat-state'; from: string; state: 'active' | 'composing' | 'paused' | 'inactive' | 'gone' }
  | { type: 'omemo-devices'; from: string; namespace: XmppOmemoNamespace; deviceIds: number[] }
  | { type: 'roster'; contacts: Array<{ jid: string; name: string }> };

type Listener = (event: XmppEvent) => void;

export interface XmppOmemoPayload {
  namespace: XmppOmemoNamespace;
  senderDeviceId: number;
  encryptedKey: string;
  keyExchange: boolean;
  ciphertext: string;
  iv?: string;
}

interface PendingIq {
  resolve: (element: Element) => void;
  reject: (error: Error) => void;
  timer: number;
}

export class XmppIqError extends Error {
  constructor(
    message: string,
    readonly condition: string | undefined,
    readonly stanzaType: string | undefined,
  ) {
    super(message);
    this.name = 'XmppIqError';
  }
}

export class XmppClient {
  private socket: WebSocket | undefined;
  private credentials: XmppCredentials | undefined;
  private listeners = new Set<Listener>();
  private activityId: string | undefined;
  private authenticated = false;
  private bound = false;
  private stopped = true;
  private reconnectAttempt = 0;
  private reconnectTimer: number | undefined;
  private scram: ScramSession | undefined;
  private expectedServerSignature: string | undefined;
  private readonly stream = new XmppStreamManager();
  private serverSupportsStreamManagement = false;
  private readonly pendingIq = new Map<string, PendingIq>();
  private omemoDeviceId: number | undefined;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(credentials: XmppCredentials): Promise<void> {
    const endpoint = new URL(credentials.endpoint);
    if (endpoint.protocol !== 'wss:') throw new Error('XMPP endpoint must use verified wss:// TLS');
    const jid = parseJid(credentials.jid);
    if (!jid.local || !jid.domain) throw new Error('A complete XMPP JID is required');
    this.credentials = { ...credentials, jid: `${jid.local}@${jid.domain}` };
    this.stopped = false;
    this.reconnectAttempt = 0;
    this.openSocket();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.socket?.close(1000, 'Local account disconnected');
    this.socket = undefined;
    if (this.activityId) networkPolicy.setState(this.activityId, 'closed');
    this.resetSession();
    this.stream.reset();
    this.rejectPendingIq(new Error('XMPP account disconnected'));
    this.emit({ type: 'state', state: 'offline' });
  }

  requestIq(innerXml: string, options: { type?: 'get' | 'set'; to?: string; timeoutMs?: number } = {}): Promise<Element> {
    if (!this.bound || this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('XMPP account is offline'));
    const id = `relayless-${crypto.randomUUID()}`;
    const to = options.to ? ` to="${escapeXml(options.to)}"` : '';
    const type = options.type ?? 'get';
    return new Promise<Element>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pendingIq.delete(id);
        reject(new Error('XMPP server did not answer the request'));
      }, options.timeoutMs ?? 12_000);
      this.pendingIq.set(id, { resolve, reject, timer });
      try { this.send(`<iq type="${type}" id="${id}"${to}>${innerXml}</iq>`); }
      catch (error) {
        window.clearTimeout(timer);
        this.pendingIq.delete(id);
        reject(error instanceof Error ? error : new Error('XMPP request failed'));
      }
    });
  }

  sendEncryptedMessage(to: string, encryptedXml: string, namespace: XmppOmemoNamespace = 'urn:xmpp:omemo:2'): string {
    if (!this.bound || this.socket?.readyState !== WebSocket.OPEN) throw new Error('XMPP account is offline');
    const id = crypto.randomUUID();
    const legacyFallback = namespace === 'eu.siacs.conversations.axolotl'
      ? '<body>[This message is OMEMO encrypted]</body>'
      : '';
    this.send(
      `<message to="${escapeXml(to)}" type="chat" id="${id}">` +
        encryptedXml +
        legacyFallback +
        `<encryption xmlns="urn:xmpp:eme:0" namespace="${namespace}"/>` +
        `<origin-id xmlns="urn:xmpp:sid:0" id="${id}"/>` +
        `<store xmlns="urn:xmpp:hints"/>` +
        `<request xmlns="urn:xmpp:receipts"/>` +
      `</message>`,
    );
    return id;
  }

  sendMessage(to: string, body: string): string {
    if (!this.bound || this.socket?.readyState !== WebSocket.OPEN) throw new Error('XMPP account is offline');
    if (utf8(body).byteLength > 64 * 1024) throw new Error('Message exceeds the 64 KiB safety limit');
    const id = crypto.randomUUID();
    this.send(
      `<message to="${escapeXml(to)}" type="chat" id="${id}">` +
        `<body>${escapeXml(body)}</body>` +
        `<origin-id xmlns="urn:xmpp:sid:0" id="${id}"/>` +
        `<active xmlns="http://jabber.org/protocol/chatstates"/>` +
        `<request xmlns="urn:xmpp:receipts"/>` +
        `<store xmlns="urn:xmpp:hints"/>` +
      `</message>`,
    );
    return id;
  }

  addContact(jid: string, name?: string): string {
    if (!this.bound || this.socket?.readyState !== WebSocket.OPEN) throw new Error('XMPP account is offline');
    const contact = parseJid(jid.trim());
    if (!contact.local || !contact.domain) throw new Error('A complete contact JID is required');
    const bare = `${contact.local}@${contact.domain}`;
    const id = `roster-${crypto.randomUUID()}`;
    const label = name?.trim() ? ` name="${escapeXml(name.trim())}"` : '';
    this.send(`<iq type="set" id="${id}"><query xmlns="jabber:iq:roster"><item jid="${escapeXml(bare)}"${label}/></query></iq>`);
    this.send(`<presence to="${escapeXml(bare)}" type="subscribe"/>`);
    return bare;
  }

  removeContact(jid: string): void {
    if (!this.bound || this.socket?.readyState !== WebSocket.OPEN) throw new Error('XMPP account is offline');
    const contact = parseJid(jid.trim());
    if (!contact.local || !contact.domain) throw new Error('A complete contact JID is required');
    const bare = `${contact.local}@${contact.domain}`;
    this.send(`<presence to="${escapeXml(bare)}" type="unsubscribe"/>`);
    this.send(`<presence to="${escapeXml(bare)}" type="unsubscribed"/>`);
    this.send(`<iq type="set" id="roster-remove-${crypto.randomUUID()}"><query xmlns="jabber:iq:roster"><item jid="${escapeXml(bare)}" subscription="remove"/></query></iq>`);
  }

  setPresence(show?: 'away' | 'dnd'): void {
    this.send(show ? `<presence><show>${show}</show></presence>` : '<presence/>');
  }

  setChatState(to: string, state: 'active' | 'composing' | 'paused' | 'inactive' | 'gone'): void {
    if (!this.bound || this.socket?.readyState !== WebSocket.OPEN) return;
    this.send(`<message to="${escapeXml(to)}" type="chat"><${state} xmlns="http://jabber.org/protocol/chatstates"/><no-store xmlns="urn:xmpp:hints"/></message>`);
  }

  private openSocket(): void {
    if (!this.credentials || this.stopped) return;
    const endpoint = new URL(this.credentials.endpoint);
    this.resetSession();
    this.emit({ type: 'state', state: this.reconnectAttempt ? 'reconnecting' : 'connecting' });
    this.activityId = networkPolicy.open({
      protocol: 'XMPP',
      destination: endpoint.hostname,
      port: Number(endpoint.port || 443),
      kind: 'xmpp-provider',
      source: 'user',
    });
    try {
      this.socket = new WebSocket(endpoint, 'xmpp');
    } catch (error) {
      this.fail(redactError(error));
      return;
    }
    this.socket.addEventListener('open', () => {
      if (this.activityId) networkPolicy.setState(this.activityId, 'open');
      this.openStream();
    });
    this.socket.addEventListener('message', (event) => this.handleFrame(String(event.data)));
    this.socket.addEventListener('error', () => this.fail('Secure WebSocket connection failed'));
    this.socket.addEventListener('close', () => {
      if (this.activityId) networkPolicy.setState(this.activityId, 'closed');
      if (!this.stopped) { this.stream.suspend(); this.scheduleReconnect(); }
    });
  }

  private openStream(): void {
    const domain = parseJid(this.credentials?.jid ?? '').domain;
    this.send(`<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" to="${escapeXml(domain)}" version="1.0"/>`);
  }

  private async handleFrame(xml: string): Promise<void> {
    try {
      const element = parseXmppElement(xml);
      switch (element.localName) {
        case 'features':
          await this.handleFeatures(element);
          break;
        case 'challenge':
          await this.handleChallenge(element.textContent ?? '');
          break;
        case 'success':
          if (this.expectedServerSignature) {
            verifyServerFinal(decodeSasl(element.textContent ?? ''), this.expectedServerSignature);
          }
          this.authenticated = true;
          this.openStream();
          break;
        case 'failure':
          throw new Error(`XMPP authentication failed: ${element.textContent?.trim() || 'rejected'}`);
        case 'iq':
          this.handleIq(element);
          break;
        case 'message':
          this.handleMessage(element);
          break;
        case 'presence':
          this.emit({
            type: 'presence',
            from: bareJid(element.getAttribute('from') ?? ''),
            show: textOf(element, 'show') ?? (element.getAttribute('type') === 'unavailable' ? 'offline' : 'online'),
          });
          break;
        case 'enabled':
          this.stream.enable(element.getAttribute('id') ?? '', element.getAttribute('resume') === 'true');
          this.finishOnline();
          break;
        case 'resumed': {
          const pending = this.stream.resume(Number(element.getAttribute('h') ?? '0'));
          this.bound = true;
          this.reconnectAttempt = 0;
          for (const stanza of pending) this.send(stanza, false);
          this.emit({ type: 'state', state: 'online' });
          break;
        }
        case 'a':
          this.stream.acknowledge(Number(element.getAttribute('h') ?? '-1'));
          break;
        case 'r':
          this.send(`<a xmlns="urn:xmpp:sm:3" h="${this.stream.inboundCount}"/>`, false);
          break;
        case 'failed':
          this.stream.reset();
          this.bound = false;
          this.requestBinding();
          break;
      }
      if (element.localName === 'iq' || element.localName === 'message' || element.localName === 'presence') this.stream.countInbound();
    } catch (error) {
      this.fail(redactError(error));
    }
  }

  private async handleFeatures(features: Element): Promise<void> {
    if (!this.authenticated) {
      const mechanisms = descendants(features, 'mechanism').map((item) => item.textContent ?? '');
      const jid = parseJid(this.credentials?.jid ?? '');
      this.emit({ type: 'state', state: 'authenticating' });
      if (mechanisms.includes('SCRAM-SHA-256')) {
        this.scram = createScramSession(jid.local, 'SHA-256');
        this.send(`<auth xmlns="urn:ietf:params:xml:ns:xmpp-sasl" mechanism="SCRAM-SHA-256">${encodeSasl(this.scram.firstMessage)}</auth>`);
      } else if (mechanisms.includes('SCRAM-SHA-1')) {
        this.scram = createScramSession(jid.local, 'SHA-1');
        this.send(`<auth xmlns="urn:ietf:params:xml:ns:xmpp-sasl" mechanism="SCRAM-SHA-1">${encodeSasl(this.scram.firstMessage)}</auth>`);
      } else if (mechanisms.includes('PLAIN')) {
        const credentials = `\0${jid.local}\0${this.credentials?.password ?? ''}`;
        this.send(`<auth xmlns="urn:ietf:params:xml:ns:xmpp-sasl" mechanism="PLAIN">${bytesToBase64(utf8(credentials))}</auth>`);
      } else {
        throw new Error('Provider does not offer SCRAM-SHA-256, SCRAM-SHA-1, or TLS-protected PLAIN');
      }
      return;
    }
    this.serverSupportsStreamManagement = descendants(features, 'sm').some((item) => item.namespaceURI === 'urn:xmpp:sm:3');
    if (!this.bound && this.stream.resumable && this.serverSupportsStreamManagement) {
      this.send(this.stream.resumeRequest(), false);
      return;
    }
    if (!this.bound && firstDescendant(features, 'bind')) {
      this.requestBinding();
    }
  }

  private async handleChallenge(encoded: string): Promise<void> {
    if (!this.scram || !this.credentials) throw new Error('Unexpected XMPP SASL challenge');
    const result = await this.scram.respond(decodeSasl(encoded), this.credentials.password);
    this.expectedServerSignature = result.serverSignature;
    this.send(`<response xmlns="urn:ietf:params:xml:ns:xmpp-sasl">${encodeSasl(result.response)}</response>`);
  }

  private handleIq(iq: Element): void {
    const id = iq.getAttribute('id') ?? '';
    const pending = this.pendingIq.get(id);
    if (pending) {
      window.clearTimeout(pending.timer);
      this.pendingIq.delete(id);
      if (iq.getAttribute('type') === 'error') pending.reject(createXmppIqError(iq));
      else pending.resolve(iq);
      return;
    }
    if (id === 'bind-1' && iq.getAttribute('type') === 'result') {
      this.bound = true;
      this.reconnectAttempt = 0;
      if (this.serverSupportsStreamManagement) this.send('<enable xmlns="urn:xmpp:sm:3" resume="true"/>', false);
      else this.finishOnline();
      return;
    }
    const query = firstDescendant(iq, 'query');
    if (query?.namespaceURI === 'jabber:iq:roster') {
      const contacts = descendants(query, 'item').map((item) => ({
        jid: item.getAttribute('jid') ?? '',
        name: item.getAttribute('name') || item.getAttribute('jid') || '',
      }));
      this.emit({ type: 'roster', contacts });
    }
  }

  private handleMessage(message: Element): void {
    if (message.getAttribute('type') === 'error') {
      const error = firstDescendant(message, 'error');
      const condition = error ? Array.from(error.children).find((child) => child.namespaceURI === 'urn:ietf:params:xml:ns:xmpp-stanzas') : undefined;
      this.emit({ type: 'message-error', id: stableMessageId(message), from: bareJid(message.getAttribute('from') ?? ''), detail: `XMPP delivery failed${condition ? `: ${condition.localName}` : ''}` });
      return;
    }
    const omemoDevices = descendants(message, 'items').find((item) => item.namespaceURI === 'http://jabber.org/protocol/pubsub#event' &&
      ['urn:xmpp:omemo:2:devices', 'eu.siacs.conversations.axolotl.devicelist'].includes(item.getAttribute('node') ?? ''));
    if (omemoDevices) {
      const namespace: XmppOmemoNamespace = omemoDevices.getAttribute('node') === 'urn:xmpp:omemo:2:devices'
        ? 'urn:xmpp:omemo:2'
        : 'eu.siacs.conversations.axolotl';
      const deviceIds = descendants(omemoDevices, 'device')
        .filter((device) => device.namespaceURI === namespace)
        .map((device) => Number(device.getAttribute('id')))
        .filter((id) => Number.isInteger(id) && id > 0 && id <= 0x7fffffff);
      this.emit({ type: 'omemo-devices', from: bareJid(message.getAttribute('from') ?? ''), namespace, deviceIds: [...new Set(deviceIds)] });
      return;
    }
    const forwarded = descendants(message, 'forwarded').find((item) => item.namespaceURI === 'urn:xmpp:forward:0');
    if (forwarded) {
      const archived = descendants(forwarded, 'message')[0];
      if (!archived) return;
      const delay = descendants(forwarded, 'delay').find((item) => item.namespaceURI === 'urn:xmpp:delay');
      this.emitMessage(archived, delay?.getAttribute('stamp') ? Date.parse(delay.getAttribute('stamp')!) : Date.now(), true);
      return;
    }
    const chatState = ['active', 'composing', 'paused', 'inactive', 'gone'] as const;
    const state = chatState.find((name) => descendants(message, name).some((item) => item.namespaceURI === 'http://jabber.org/protocol/chatstates'));
    if (state) this.emit({ type: 'chat-state', from: bareJid(message.getAttribute('from') ?? ''), state });
    const receipt = firstDescendant(message, 'received');
    if (receipt?.namespaceURI === 'urn:xmpp:receipts') {
      this.emit({ type: 'receipt', id: receipt.getAttribute('id') ?? '', from: bareJid(message.getAttribute('from') ?? '') });
    }
    const id = this.emitMessage(message, Date.now(), false);
    if (!id) return;
    const from = bareJid(message.getAttribute('from') ?? '');
    if (firstDescendant(message, 'request')) {
      this.send(`<message to="${escapeXml(from)}"><received xmlns="urn:xmpp:receipts" id="${escapeXml(id)}"/></message>`);
    }
  }

  private emitMessage(message: Element, timestamp: number, archived: boolean): string | undefined {
    const encrypted = descendants(message, 'encrypted').find((item) =>
      item.namespaceURI === 'urn:xmpp:omemo:2' || item.namespaceURI === 'eu.siacs.conversations.axolotl');
    if (encrypted) {
      const header = firstDescendant(encrypted, 'header');
      const payload = firstDescendant(encrypted, 'payload');
      const ownJid = bareJid(this.credentials?.jid ?? '');
      const namespace = encrypted.namespaceURI as XmppOmemoNamespace;
      const keyGroup = namespace === 'urn:xmpp:omemo:2'
        ? descendants(header ?? encrypted, 'keys').find((item) => bareJid(item.getAttribute('jid') ?? '') === ownJid)
        : header;
      const ownDeviceId = Number(this.omemoDeviceId);
      const key = descendants(keyGroup ?? encrypted, 'key').find((item) => Number(item.getAttribute('rid')) === ownDeviceId);
      const senderDeviceId = Number(header?.getAttribute('sid'));
      if (payload && key && Number.isInteger(senderDeviceId) && senderDeviceId > 0) {
        const id = stableMessageId(message);
        this.emit({
          type: 'encrypted-message', id, from: bareJid(message.getAttribute('from') ?? ''),
          timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(), archived,
          payload: {
            namespace, senderDeviceId,
            encryptedKey: key.textContent?.trim() ?? '',
            keyExchange: namespace === 'urn:xmpp:omemo:2'
              ? key.getAttribute('kex') === 'true' || key.getAttribute('kex') === '1'
              : key.getAttribute('prekey') === 'true' || key.getAttribute('prekey') === '1',
            ciphertext: payload.textContent?.trim() ?? '',
            iv: namespace === 'eu.siacs.conversations.axolotl' ? firstDescendant(header ?? encrypted, 'iv')?.textContent?.trim() : undefined,
          },
        });
        return id;
      }
      return undefined;
    }
    const body = textOf(message, 'body');
    if (body === undefined) return undefined;
    const id = stableMessageId(message);
    const from = bareJid(message.getAttribute('from') ?? '');
    const to = bareJid(message.getAttribute('to') ?? '');
    const own = bareJid(this.credentials?.jid ?? '');
    const direction = from === own ? 'outgoing' : 'incoming';
    this.emit({ type: 'message', id, from: direction === 'outgoing' ? to : from, body, timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(), direction, archived });
    return id;
  }

  private requestBinding(): void {
    const resource = this.credentials?.resource || 'relayless';
    this.send(`<iq type="set" id="bind-1"><bind xmlns="urn:ietf:params:xml:ns:xmpp-bind"><resource>${escapeXml(resource)}</resource></bind></iq>`, false);
  }

  private finishOnline(): void {
    this.reconnectAttempt = 0;
    this.send('<iq type="get" id="roster-1"><query xmlns="jabber:iq:roster"/></iq>');
    this.send('<presence/>');
    if (this.credentials?.restoreArchive) {
      const start = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      this.send(`<iq type="set" id="mam-${crypto.randomUUID()}"><query xmlns="urn:xmpp:mam:2"><x xmlns="jabber:x:data" type="submit"><field var="FORM_TYPE" type="hidden"><value>urn:xmpp:mam:2</value></field><field var="start"><value>${escapeXml(start)}</value></field></x><set xmlns="http://jabber.org/protocol/rsm"><max>100</max></set></query></iq>`);
    }
    this.emit({ type: 'state', state: 'online' });
  }

  private send(xml: string, track = true): void {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('XMPP WebSocket is not open');
    this.socket.send(xml);
    if (track && /^<(message|presence|iq)\b/.test(xml)) {
      this.stream.track(xml);
      if (this.stream.enabled && this.stream.pendingCount % 5 === 0) this.socket.send('<r xmlns="urn:xmpp:sm:3"/>');
    }
  }

  private fail(detail: string): void {
    if (this.activityId) networkPolicy.setState(this.activityId, 'failed');
    this.emit({ type: 'state', state: 'error', detail });
    this.rejectPendingIq(new Error(detail));
    this.socket?.close();
  }

  private scheduleReconnect(): void {
    this.reconnectAttempt += 1;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.reconnectAttempt - 1, 5));
    if (this.activityId) networkPolicy.setState(this.activityId, 'retrying');
    this.emit({ type: 'state', state: 'reconnecting', detail: `Retry in ${Math.ceil(delay / 1000)}s` });
    this.reconnectTimer = window.setTimeout(() => this.openSocket(), delay);
  }

  private resetSession(): void {
    this.authenticated = false;
    this.bound = false;
    this.scram = undefined;
    this.expectedServerSignature = undefined;
    this.serverSupportsStreamManagement = false;
  }

  private emit(event: XmppEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  setOmemoDeviceId(deviceId: number | undefined): void {
    this.omemoDeviceId = deviceId;
  }

  private rejectPendingIq(error: Error): void {
    for (const pending of this.pendingIq.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingIq.clear();
  }
}

function parseJid(jid: string): { local: string; domain: string } {
  const bare = jid.split('/')[0] ?? '';
  const separator = bare.indexOf('@');
  if (separator < 1) return { local: '', domain: bare };
  return { local: bare.slice(0, separator), domain: bare.slice(separator + 1) };
}

function bareJid(jid: string): string {
  return jid.split('/')[0] ?? jid;
}

function stableMessageId(message: Element): string {
  const origin = descendants(message, 'origin-id').find((item) => item.namespaceURI === 'urn:xmpp:sid:0');
  return origin?.getAttribute('id') || message.getAttribute('id') || crypto.randomUUID();
}

function createXmppIqError(iq: Element): XmppIqError {
  const error = firstDescendant(iq, 'error');
  const condition = error ? Array.from(error.children).find((child) => child.namespaceURI === 'urn:ietf:params:xml:ns:xmpp-stanzas') : undefined;
  const conditionName = condition?.localName;
  return new XmppIqError(
    `XMPP request rejected${conditionName ? `: ${conditionName}` : ''}`,
    conditionName,
    error?.getAttribute('type') ?? undefined,
  );
}
