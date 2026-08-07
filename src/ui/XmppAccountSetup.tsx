import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Account } from '../models/types';
import { discoverXmppEndpoints, xmppDomainFromJid } from '../protocols/xmpp/discovery';
import {
  XmppRegistrationClient,
  XmppRegistrationError,
  type RegistrationField,
  type XmppRegistrationForm,
} from '../protocols/xmpp/registration';
import { redactError } from '../security/redaction';
import { copy, type Language } from './i18n';

interface Props {
  addXmpp: (account: Account) => Promise<void>;
  t: typeof copy[Language];
}

type Mode = 'signin' | 'register';

export function XmppAccountSetup({ addXmpp, t }: Props) {
  const ru = t === copy.ru;
  const [mode, setMode] = useState<Mode>('signin');
  const [signin, setSignin] = useState({ jid: '', password: '', endpoint: '', alias: '', mamEnabled: false });
  const [server, setServer] = useState({ domain: '', endpoint: '' });
  const [discoveryNote, setDiscoveryNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [registration, setRegistration] = useState<XmppRegistrationForm>();
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [complete, setComplete] = useState(false);
  const registrationClient = useRef<XmppRegistrationClient | undefined>(undefined);

  useEffect(() => () => registrationClient.current?.close(), []);

  const switchMode = (next: Mode) => {
    registrationClient.current?.close();
    registrationClient.current = undefined;
    setMode(next); setError(''); setRegistration(undefined); setAnswers({}); setComplete(false); setDiscoveryNote('');
  };

  const discoverSignin = async () => {
    setBusy(true); setError('');
    try {
      const result = await discoverXmppEndpoints(xmppDomainFromJid(signin.jid));
      const endpoint = result.endpoints[0]?.url ?? '';
      setSignin((current) => ({ ...current, endpoint }));
      setDiscoveryNote(discoveryMessage(result.warning, ru));
    } catch (reason) { setError(redactError(reason)); }
    finally { setBusy(false); }
  };

  const submitSignin = (event: FormEvent) => {
    event.preventDefault();
    void addXmpp({
      id: crypto.randomUUID(), protocol: 'xmpp', address: signin.jid.trim(),
      alias: signin.alias.trim() || signin.jid.trim(), endpoint: signin.endpoint.trim(),
      secret: signin.password, presence: 'offline', connectionState: 'offline', enabled: true, mamEnabled: signin.mamEnabled,
    }).then(() => setSignin({ jid: '', password: '', endpoint: '', alias: '', mamEnabled: false })).catch((reason) => setError(redactError(reason)));
  };

  const inspectRegistration = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(''); setRegistration(undefined); setAnswers({}); setComplete(false);
    try {
      let endpoint = server.endpoint.trim();
      const domain = xmppDomainFromJid(server.domain);
      if (!endpoint) {
        const result = await discoverXmppEndpoints(domain);
        endpoint = result.endpoints[0]?.url ?? '';
        setDiscoveryNote(discoveryMessage(result.warning, ru));
      }
      setServer({ domain, endpoint });
      const client = new XmppRegistrationClient();
      registrationClient.current?.close(); registrationClient.current = client;
      const form = await client.inspect({ domain, endpoint });
      setRegistration(form);
      setAnswers(Object.fromEntries(form.fields.filter((field) => field.values.length > 0).map((field) => [field.key, field.type === 'list-multi' ? field.values : field.values[0] ?? ''])));
    } catch (reason) { setError(registrationErrorMessage(reason, ru)); registrationClient.current?.close(); }
    finally { setBusy(false); }
  };

  const submitRegistration = async (event: FormEvent) => {
    event.preventDefault(); if (!registrationClient.current || !registration) return;
    setBusy(true); setError('');
    try {
      await registrationClient.current.submit(answers);
      setComplete(true);
      const username = answerByKey(answers, 'username');
      const password = answerByKey(answers, 'password');
      if (username && password) {
        await addXmpp({
          id: crypto.randomUUID(), protocol: 'xmpp', address: `${username}@${registration.domain}`,
          alias: username, endpoint: server.endpoint, secret: password, presence: 'offline', connectionState: 'offline', enabled: true,
        });
      }
    } catch (reason) { setError(registrationErrorMessage(reason, ru)); }
    finally { setBusy(false); }
  };

  return (
    <div className="xmpp-setup">
      <div className="setup-tabs" role="tablist" aria-label={ru ? 'Действие XMPP' : 'XMPP action'}>
        <button role="tab" aria-selected={mode === 'signin'} className={mode === 'signin' ? 'active' : ''} onClick={() => switchMode('signin')}>{ru ? 'Войти' : 'Sign in'}</button>
        <button role="tab" aria-selected={mode === 'register'} className={mode === 'register' ? 'active' : ''} onClick={() => switchMode('register')}>{ru ? 'Регистрация' : 'Register'}</button>
      </div>

      {mode === 'signin' ? (
        <form className="connect-form" onSubmit={submitSignin}>
          <label>{ru ? 'Адрес XMPP' : 'XMPP address'}<input type="email" value={signin.jid} onChange={(event) => setSignin({ ...signin, jid: event.target.value, endpoint: '' })} placeholder="name@example.org" required/></label>
          <label>{ru ? 'Пароль' : 'Password'}<input type="password" autoComplete="current-password" value={signin.password} onChange={(event) => setSignin({ ...signin, password: event.target.value })} required/></label>
          <label>{ru ? 'Имя в приложении' : 'Display name'}<input value={signin.alias} onChange={(event) => setSignin({ ...signin, alias: event.target.value })} placeholder={ru ? 'Необязательно' : 'Optional'}/></label>
          <button className="secondary endpoint-discovery" type="button" disabled={busy || !signin.jid.includes('@')} onClick={() => void discoverSignin()}>{busy ? (ru ? 'Ищу сервер…' : 'Finding server…') : (ru ? 'Найти настройки сервера' : 'Find server settings')}</button>
          {discoveryNote && <p className="setup-note">{discoveryNote}</p>}
          <details className="connection-advanced" open={!signin.endpoint}>
            <summary>{ru ? 'Адрес подключения' : 'Connection address'}</summary>
            <label>{ru ? 'Защищённый WebSocket' : 'Secure WebSocket'}<input type="url" pattern="wss://.*" value={signin.endpoint} onChange={(event) => setSignin({ ...signin, endpoint: event.target.value })} placeholder="wss://example.org/xmpp-websocket" required/></label>
            <label className="registration-check"><input type="checkbox" checked={signin.mamEnabled} onChange={(event) => setSignin({ ...signin, mamEnabled: event.target.checked })}/><span>{ru ? 'Загрузить до 100 сообщений за последние 7 дней' : 'Load up to 100 messages from the last 7 days'}</span></label>
          </details>
          {error && <p className="inline-error" role="alert">{error}</p>}
          <button className="primary" type="submit">{ru ? 'Сохранить и подключить' : 'Save and connect'}</button>
        </form>
      ) : complete ? (
        <div className="registration-complete" role="status">
          <strong>{ru ? 'Аккаунт создан' : 'Account created'}</strong>
          <p>{ru ? 'Данные добавлены в приложение. Теперь можно подключиться.' : 'The account was added to the app and is ready to connect.'}</p>
          <button className="primary" onClick={() => switchMode('signin')}>{ru ? 'Готово' : 'Done'}</button>
        </div>
      ) : registration ? (
        <form className="registration-form" onSubmit={submitRegistration}>
          <div className={`server-capability ${registration.captcha ? 'challenge' : 'ready'}`}>
            <strong>{registration.captcha ? (ru ? 'Сервер запросил проверку' : 'Server requested verification') : (ru ? 'Регистрация доступна' : 'Registration available')}</strong>
            <small>{registration.domain}</small>
          </div>
          {registration.instructions && <p className="registration-instructions">{registration.instructions}</p>}
          {registration.redirectUrl && <a className="secondary external-registration" href={registration.redirectUrl} target="_blank" rel="noreferrer">{ru ? 'Продолжить на сайте сервера' : 'Continue on server website'}</a>}
          {registration.fields.map((field) => <RegistrationInput key={`${field.key}-${field.label}`} field={field} value={answers[field.key]} onChange={(value) => setAnswers((current) => ({ ...current, [field.key]: value }))}/>) }
          {registration.fields.length > 0 && <button className="primary" type="submit" disabled={busy}>{busy ? (ru ? 'Создаю…' : 'Creating…') : (ru ? 'Создать аккаунт' : 'Create account')}</button>}
          {registration.fields.length === 0 && !registration.redirectUrl && <p className="inline-error">{ru ? 'Сервер не прислал совместимую форму. Используйте сайт провайдера.' : 'The server did not return a compatible form. Use the provider website.'}</p>}
          {error && <p className="inline-error" role="alert">{error}</p>}
          <button className="text-action" type="button" onClick={() => { registrationClient.current?.close(); setRegistration(undefined); setError(''); }}>{ru ? 'Выбрать другой сервер' : 'Choose another server'}</button>
        </form>
      ) : (
        <form className="connect-form registration-start" onSubmit={inspectRegistration}>
          <p className="setup-intro">{ru ? 'Укажите сервер. Приложение само запросит его форму регистрации — включая CAPTCHA и дополнительные условия.' : 'Enter a server. The app will request its registration form, including CAPTCHA and extra terms.'}</p>
          <label>{ru ? 'Домен сервера' : 'Server domain'}<input value={server.domain} onChange={(event) => setServer({ ...server, domain: event.target.value, endpoint: '' })} placeholder="example.org" required/></label>
          <details className="connection-advanced">
            <summary>{ru ? 'Адрес подключения вручную' : 'Manual connection address'}</summary>
            <label>{ru ? 'Защищённый WebSocket' : 'Secure WebSocket'}<input type="url" pattern="wss://.*" value={server.endpoint} onChange={(event) => setServer({ ...server, endpoint: event.target.value })} placeholder="wss://example.org/xmpp-websocket"/></label>
          </details>
          {discoveryNote && <p className="setup-note">{discoveryNote}</p>}
          {error && <p className="inline-error" role="alert">{error}</p>}
          <button className="primary" type="submit" disabled={busy}>{busy ? (ru ? 'Проверяю сервер…' : 'Checking server…') : (ru ? 'Проверить и продолжить' : 'Check and continue')}</button>
        </form>
      )}
    </div>
  );
}

function RegistrationInput({ field, value, onChange }: { field: RegistrationField; value?: string | string[]; onChange: (value: string | string[]) => void }) {
  if (field.type === 'hidden') return null;
  if (field.type === 'fixed') return <p className="registration-fixed">{field.values.join('\n')}</p>;
  const scalar = Array.isArray(value) ? value[0] ?? '' : value ?? '';
  return (
    <label className={`registration-field ${field.media.length ? 'has-media' : ''}`}>
      {field.media.map((media) => <img key={media.uri} className="captcha-media" src={media.uri} alt={field.label} referrerPolicy="no-referrer"/>)}
      <span>{field.label}{field.required && <em aria-label="required"> *</em>}</span>
      {field.type === 'boolean' ? (
        <span className="registration-check"><input type="checkbox" checked={scalar === '1' || scalar === 'true'} onChange={(event) => onChange(event.target.checked ? '1' : '0')}/><span>{field.description || field.label}</span></span>
      ) : field.type === 'list-single' ? (
        <select value={scalar} required={field.required} onChange={(event) => onChange(event.target.value)}>{!field.required && <option value=""/>}{field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
      ) : field.type === 'list-multi' ? (
        <select multiple value={Array.isArray(value) ? value : []} required={field.required} onChange={(event) => onChange([...event.target.selectedOptions].map((option) => option.value))}>{field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
      ) : field.type === 'text-multi' ? (
        <textarea value={scalar} required={field.required} onChange={(event) => onChange(event.target.value)}/>
      ) : (
        <input type={field.type === 'text-private' ? 'password' : field.type === 'jid-single' ? 'email' : 'text'} autoComplete={field.type === 'text-private' ? 'new-password' : 'off'} value={scalar} required={field.required} onChange={(event) => onChange(event.target.value)}/>
      )}
      {field.description && field.type !== 'boolean' && <small>{field.description}</small>}
    </label>
  );
}

function answerByKey(answers: Record<string, string | string[]>, wanted: string): string {
  const key = Object.keys(answers).find((item) => item.toLowerCase() === wanted);
  const value = key ? answers[key] : undefined;
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function discoveryMessage(warning: 'cors-or-unavailable' | 'no-websocket-advertised' | undefined, ru: boolean): string {
  if (!warning) return ru ? 'Настройки получены от сервера.' : 'Settings received from the server.';
  if (warning === 'no-websocket-advertised') return ru ? 'Сервер не указал WebSocket. Подставлен стандартный адрес — при необходимости измените его.' : 'The server did not advertise WebSocket. A conventional address was used; edit it if needed.';
  return ru ? 'Автонастройка недоступна из-за CORS или конфигурации сервера. Подставлен стандартный адрес.' : 'Auto-configuration is unavailable due to CORS or server setup. A conventional address was used.';
}

function registrationErrorMessage(reason: unknown, ru: boolean): string {
  if (!(reason instanceof XmppRegistrationError)) return redactError(reason);
  const messages: Record<string, [string, string]> = {
    conflict: ['Это имя уже занято.', 'This username is already taken.'],
    forbidden: ['Сервер запретил регистрацию из приложения.', 'The server does not allow registration from the app.'],
    'not-acceptable': ['Сервер отклонил данные или CAPTCHA. Проверьте поля и попробуйте ещё раз.', 'The server rejected the form or CAPTCHA. Check the fields and try again.'],
    'not-authorized': ['Сессия регистрации истекла. Начните заново.', 'The registration session expired. Start again.'],
    'resource-constraint': ['Слишком много попыток. Подождите и повторите позже.', 'Too many attempts. Wait and try again later.'],
    'service-unavailable': ['Этот сервер не поддерживает регистрацию в приложении.', 'This server does not support in-app registration.'],
    timeout: ['Сервер не ответил вовремя.', 'The server did not respond in time.'],
    unknown: ['Сервер отклонил регистрацию.', 'The server rejected registration.'],
  };
  return (messages[reason.code] ?? messages.unknown)?.[ru ? 0 : 1] ?? redactError(reason);
}
