import { networkPolicy } from '../../network/policy';
import { escapeXml, firstDescendant, parseXmppElement } from './xml';
import { normalizeXmppDomain } from './discovery';

const REGISTER_NS = 'jabber:iq:register';
const DATA_FORM_NS = 'jabber:x:data';
const BOB_NS = 'urn:xmpp:bob';
const MAX_CAPTCHA_BYTES = 192 * 1024;

export type RegistrationFieldType =
  | 'boolean' | 'fixed' | 'hidden' | 'jid-single' | 'list-multi' | 'list-single'
  | 'text-multi' | 'text-private' | 'text-single';

export interface RegistrationOption { label: string; value: string }

export interface RegistrationMedia { mime: string; uri: string }

export interface RegistrationField {
  key: string;
  label: string;
  description?: string;
  type: RegistrationFieldType;
  required: boolean;
  values: string[];
  options: RegistrationOption[];
  media: RegistrationMedia[];
}

export interface XmppRegistrationForm {
  domain: string;
  instructions?: string;
  fields: RegistrationField[];
  legacy: boolean;
  captcha: boolean;
  redirectUrl?: string;
  alreadyRegistered: boolean;
}

export type RegistrationErrorCode =
  | 'conflict' | 'forbidden' | 'not-acceptable' | 'not-authorized'
  | 'resource-constraint' | 'service-unavailable' | 'timeout' | 'unknown';

export class XmppRegistrationError extends Error {
  constructor(public readonly code: RegistrationErrorCode, message?: string) {
    super(message || code);
    this.name = 'XmppRegistrationError';
  }
}

export interface XmppRegistrationTarget { domain: string; endpoint: string }

export class XmppRegistrationClient {
  private socket?: WebSocket;
  private target?: XmppRegistrationTarget;
  private form?: XmppRegistrationForm;
  private pending?: { id: string; resolve: (element: Element) => void; reject: (reason: unknown) => void; timer: number };
  private activityId?: string;
  private stopped = false;

  async inspect(target: XmppRegistrationTarget): Promise<XmppRegistrationForm> {
    this.close();
    const domain = normalizeXmppDomain(target.domain);
    const endpoint = new URL(target.endpoint);
    if (endpoint.protocol !== 'wss:' || endpoint.username || endpoint.password) {
      throw new Error('Регистрация разрешена только через защищённый wss:// адрес');
    }
    this.target = { domain, endpoint: endpoint.toString() };
    this.stopped = false;
    this.activityId = networkPolicy.open({
      protocol: 'XMPP', destination: endpoint.hostname, port: Number(endpoint.port || 443),
      kind: 'xmpp-provider', source: 'user',
    });
    await this.openSocket();
    const response = await this.request(`<query xmlns="${REGISTER_NS}"/>`);
    this.form = parseRegistrationElement(response, domain);
    return this.form;
  }

  async submit(values: Record<string, string | string[]>): Promise<void> {
    if (!this.socket || !this.target || !this.form) throw new Error('Сначала получите форму регистрации сервера');
    const payload = buildRegistrationSubmission(this.form, values);
    await this.request(payload, 'set');
    this.close();
  }

  close(): void {
    this.stopped = true;
    if (this.pending) {
      window.clearTimeout(this.pending.timer);
      this.pending.reject(new XmppRegistrationError('unknown', 'Регистрация отменена'));
      this.pending = undefined;
    }
    this.socket?.close(1000, 'Registration flow completed');
    this.socket = undefined;
    if (this.activityId) networkPolicy.setState(this.activityId, 'closed');
    this.activityId = undefined;
    this.form = undefined;
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.target) { reject(new Error('XMPP registration target is missing')); return; }
      let featuresSeen = false;
      const timer = window.setTimeout(() => reject(new XmppRegistrationError('timeout', 'Сервер не ответил вовремя')), 15_000);
      try { this.socket = new WebSocket(this.target.endpoint, 'xmpp'); }
      catch (error) { window.clearTimeout(timer); reject(error); return; }
      this.socket.addEventListener('open', () => {
        if (this.activityId) networkPolicy.setState(this.activityId, 'open');
        this.send(`<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" to="${escapeXml(this.target?.domain ?? '')}" version="1.0"/>`);
      });
      this.socket.addEventListener('message', (event) => {
        try {
          const element = parseXmppElement(String(event.data));
          if (element.localName === 'features' && !featuresSeen) {
            featuresSeen = true;
            window.clearTimeout(timer);
            const register = [...element.getElementsByTagNameNS('*', 'register')]
              .some((item) => item.namespaceURI === 'http://jabber.org/features/iq-register');
            if (!register) {
              reject(new XmppRegistrationError('service-unavailable', 'Этот сервер не предлагает регистрацию в приложении'));
              return;
            }
            resolve();
            return;
          }
          if (element.localName === 'iq') this.handleIq(element);
        } catch (error) { reject(error); }
      });
      this.socket.addEventListener('error', () => {
        window.clearTimeout(timer);
        if (this.activityId) networkPolicy.setState(this.activityId, 'failed');
        reject(new Error('Не удалось открыть защищённое соединение с сервером'));
      });
      this.socket.addEventListener('close', () => {
        if (this.activityId) networkPolicy.setState(this.activityId, 'closed');
        if (!this.stopped && this.pending) this.rejectPending(new Error('Сервер закрыл соединение регистрации'));
      });
    });
  }

  private request(query: string, type: 'get' | 'set' = 'get'): Promise<Element> {
    if (this.pending) throw new Error('Предыдущий запрос регистрации ещё выполняется');
    const id = `register-${crypto.randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending = undefined;
        reject(new XmppRegistrationError('timeout', 'Сервер не ответил вовремя'));
      }, 20_000);
      this.pending = { id, resolve, reject, timer };
      this.send(`<iq type="${type}" id="${id}" to="${escapeXml(this.target?.domain ?? '')}">${query}</iq>`);
    });
  }

  private handleIq(iq: Element): void {
    if (!this.pending || iq.getAttribute('id') !== this.pending.id) return;
    const current = this.pending;
    this.pending = undefined;
    window.clearTimeout(current.timer);
    if (iq.getAttribute('type') === 'error') current.reject(registrationErrorFromIq(iq));
    else if (iq.getAttribute('type') === 'result') current.resolve(iq);
    else current.reject(new XmppRegistrationError('unknown', 'Сервер вернул неожиданный ответ'));
  }

  private rejectPending(reason: unknown): void {
    if (!this.pending) return;
    const current = this.pending;
    this.pending = undefined;
    window.clearTimeout(current.timer);
    current.reject(reason);
  }

  private send(xml: string): void {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('XMPP WebSocket не открыт');
    this.socket.send(xml);
  }
}

export function parseRegistrationResponse(xml: string, domain: string): XmppRegistrationForm {
  return parseRegistrationElement(parseXmppElement(xml), normalizeXmppDomain(domain));
}

function parseRegistrationElement(iq: Element, domain: string): XmppRegistrationForm {
  if (iq.getAttribute('type') === 'error') throw registrationErrorFromIq(iq);
  const query = [...iq.getElementsByTagNameNS('*', 'query')].find((item) => item.namespaceURI === REGISTER_NS);
  if (!query) throw new XmppRegistrationError('service-unavailable', 'Сервер не вернул форму регистрации');
  const instructions = directChildText(query, 'instructions');
  const alreadyRegistered = directChild(query, 'registered') !== undefined;
  const dataForm = [...query.getElementsByTagNameNS('*', 'x')].find((item) => item.namespaceURI === DATA_FORM_NS);
  const fields = dataForm ? parseDataForm(dataForm, iq) : parseLegacyFields(query);
  const redirectUrl = safeHttpsUrl(
    [...query.getElementsByTagNameNS('*', 'x')]
      .find((item) => item.namespaceURI === 'jabber:x:oob')
      ?.getElementsByTagNameNS('*', 'url')[0]?.textContent ?? '',
  );
  return {
    domain, instructions, fields, legacy: !dataForm,
    captcha: fields.some((field) => field.media.length > 0 || /captcha|ocr|recog|challenge|qa/i.test(field.key)),
    redirectUrl, alreadyRegistered,
  };
}

function parseDataForm(form: Element, iq: Element): RegistrationField[] {
  const bob = new Map<string, { mime: string; data: string }>();
  for (const item of [...iq.getElementsByTagNameNS('*', 'data')]) {
    if (item.namespaceURI !== BOB_NS) continue;
    const cid = item.getAttribute('cid');
    const mime = item.getAttribute('type') ?? '';
    const data = (item.textContent ?? '').replace(/\s+/g, '');
    if (cid && safeImageMime(mime) && data.length <= Math.ceil(MAX_CAPTCHA_BYTES * 4 / 3)) bob.set(cid, { mime, data });
  }
  return [...form.getElementsByTagNameNS(DATA_FORM_NS, 'field')].map((field) => {
    const type = normalizeFieldType(field.getAttribute('type'));
    const key = field.getAttribute('var') ?? '';
    const media: RegistrationMedia[] = [];
    for (const uri of [...field.getElementsByTagNameNS('*', 'uri')]) {
      const raw = uri.textContent?.trim() ?? '';
      const mime = uri.getAttribute('type') ?? '';
      if (raw.startsWith('cid:')) {
        const embedded = bob.get(raw.slice(4));
        if (embedded) media.push({ mime: embedded.mime, uri: `data:${embedded.mime};base64,${embedded.data}` });
      } else {
        const safe = safeHttpsUrl(raw);
        if (safe && safeImageMime(mime)) media.push({ mime, uri: safe });
      }
    }
    return {
      key,
      label: field.getAttribute('label') || humanizeField(key),
      description: directChildText(field, 'desc'),
      type,
      required: directChild(field, 'required') !== undefined,
      values: directChildren(field, 'value').map((item) => item.textContent ?? ''),
      options: directChildren(field, 'option').map((option) => ({
        label: option.getAttribute('label') || directChildText(option, 'value') || '',
        value: directChildText(option, 'value') || '',
      })),
      media,
    };
  }).filter((field) => field.key || field.type === 'fixed');
}

function parseLegacyFields(query: Element): RegistrationField[] {
  const labels: Record<string, string> = { username: 'Имя пользователя', password: 'Пароль', email: 'Электронная почта', name: 'Имя', nick: 'Псевдоним' };
  return directChildren(query).filter((child) => child.namespaceURI === REGISTER_NS && child.localName in labels).map((child) => ({
    key: child.localName,
    label: labels[child.localName] ?? humanizeField(child.localName),
    type: child.localName === 'password' ? 'text-private' : 'text-single',
    required: child.localName === 'username' || child.localName === 'password',
    values: child.textContent ? [child.textContent] : [], options: [], media: [],
  }));
}

export function buildRegistrationSubmission(form: XmppRegistrationForm, values: Record<string, string | string[]>): string {
  if (form.legacy) {
    const body = form.fields.filter((field) => field.key).map((field) => {
      const value = values[field.key] ?? field.values;
      const scalar = Array.isArray(value) ? value[0] ?? '' : value;
      if (field.required && !scalar.trim()) throw new Error(`Заполните поле «${field.label}»`);
      return `<${field.key}>${escapeXml(scalar)}</${field.key}>`;
    }).join('');
    return `<query xmlns="${REGISTER_NS}">${body}</query>`;
  }
  const fields = form.fields.filter((field) => field.key).map((field) => {
    const supplied = values[field.key];
    const selected = supplied === undefined ? field.values : Array.isArray(supplied) ? supplied : [supplied];
    if (field.required && selected.every((value) => !value.trim())) throw new Error(`Заполните поле «${field.label}»`);
    return `<field var="${escapeXml(field.key)}">${selected.map((value) => `<value>${escapeXml(value)}</value>`).join('')}</field>`;
  }).join('');
  return `<query xmlns="${REGISTER_NS}"><x xmlns="${DATA_FORM_NS}" type="submit">${fields}</x></query>`;
}

function registrationErrorFromIq(iq: Element): XmppRegistrationError {
  const error = firstDescendant(iq, 'error');
  const known: RegistrationErrorCode[] = ['conflict', 'forbidden', 'not-acceptable', 'not-authorized', 'resource-constraint', 'service-unavailable'];
  const code = known.find((condition) => error && [...error.children].some((child) => child.localName === condition)) ?? 'unknown';
  const detail = error ? [...error.children].find((child) => child.localName === 'text')?.textContent?.trim() : undefined;
  return new XmppRegistrationError(code, detail || code);
}

function normalizeFieldType(value: string | null): RegistrationFieldType {
  const supported: RegistrationFieldType[] = ['boolean', 'fixed', 'hidden', 'jid-single', 'list-multi', 'list-single', 'text-multi', 'text-private', 'text-single'];
  return supported.includes(value as RegistrationFieldType) ? value as RegistrationFieldType : 'text-single';
}

function directChild(parent: Element, localName: string): Element | undefined {
  return [...parent.children].find((child) => child.localName === localName);
}

function directChildren(parent: Element, localName?: string): Element[] {
  return [...parent.children].filter((child) => !localName || child.localName === localName);
}

function directChildText(parent: Element, localName: string): string | undefined {
  return directChild(parent, localName)?.textContent?.trim() || undefined;
}

function safeHttpsUrl(value: string): string | undefined {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : undefined; }
  catch { return undefined; }
}

function safeImageMime(value: string): boolean {
  return ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(value.toLowerCase());
}

function humanizeField(value: string): string {
  return value.replaceAll('_', ' ').replaceAll('-', ' ').replace(/^./, (letter) => letter.toUpperCase());
}

