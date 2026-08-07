import { parseSafeXmlDocument } from './xml';

const WEBSOCKET_REL = 'urn:xmpp:alt-connections:websocket';
const DEFAULT_TIMEOUT_MS = 8_000;

export type XmppEndpointSource = 'provider' | 'host-meta-json' | 'host-meta-xrd' | 'conventional';

export interface DiscoveredXmppEndpoint {
  url: string;
  source: XmppEndpointSource;
}

export interface XmppDiscoveryResult {
  domain: string;
  endpoints: DiscoveredXmppEndpoint[];
  registrationUrl?: string;
  warning?: 'cors-or-unavailable' | 'no-websocket-advertised';
}

interface KnownXmppProvider {
  endpoints: string[];
  registrationUrl?: string;
}

const KNOWN_PROVIDERS: Readonly<Record<string, KnownXmppProvider>> = {
  'xmpp.jp': {
    endpoints: ['wss://api.xmpp.jp/ws/'],
    registrationUrl: 'https://echo.xmpp.jp/signup',
  },
};

export function normalizeXmppDomain(value: string): string {
  const candidate = value.trim().toLowerCase().replace(/\.$/, '');
  if (!candidate || candidate.includes('@') || candidate.includes('/') || candidate.includes('\\')) {
    throw new Error('Введите корректный домен XMPP-сервера');
  }
  const parsed = new URL(`https://${candidate}`);
  if (parsed.username || parsed.password || parsed.port || parsed.pathname !== '/') {
    throw new Error('Введите домен без протокола, порта и пути');
  }
  return parsed.hostname;
}

export function xmppDomainFromJid(jid: string): string {
  const bare = jid.trim().split('/')[0] ?? '';
  const separator = bare.lastIndexOf('@');
  return normalizeXmppDomain(separator >= 0 ? bare.slice(separator + 1) : bare);
}

export async function discoverXmppEndpoints(
  domainInput: string,
  fetcher: typeof fetch = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<XmppDiscoveryResult> {
  const domain = normalizeXmppDomain(domainInput);
  const knownProvider = KNOWN_PROVIDERS[domain];
  if (knownProvider) {
    return {
      domain,
      endpoints: knownProvider.endpoints.map((url) => ({ url, source: 'provider' })),
      registrationUrl: knownProvider.registrationUrl,
    };
  }
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  const discovered: DiscoveredXmppEndpoint[] = [];
  let reachedMetadata = false;

  try {
    try {
      const response = await fetcher(`https://${domain}/.well-known/host-meta.json`, {
        credentials: 'omit',
        redirect: 'follow',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
        headers: { Accept: 'application/jrd+json, application/json' },
      });
      if (response.ok) {
        reachedMetadata = true;
        const document = await response.json() as { links?: Array<{ rel?: string; href?: string }> };
        for (const link of document.links ?? []) {
          if (link.rel === WEBSOCKET_REL && link.href) addEndpoint(discovered, link.href, 'host-meta-json');
        }
      }
    } catch { /* JSON discovery may be unavailable or blocked by CORS. */ }

    if (discovered.length === 0) {
      try {
        const response = await fetcher(`https://${domain}/.well-known/host-meta`, {
          credentials: 'omit',
          redirect: 'follow',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
          headers: { Accept: 'application/xrd+xml, application/xml, text/xml' },
        });
        if (response.ok) {
          reachedMetadata = true;
          const xml = parseSafeXmlDocument(await response.text());
          for (const link of [...xml.getElementsByTagNameNS('*', 'Link')]) {
            if (link.getAttribute('rel') === WEBSOCKET_REL) {
              addEndpoint(discovered, link.getAttribute('href') ?? '', 'host-meta-xrd');
            }
          }
        }
      } catch { /* The manual endpoint remains available. */ }
    }
  } finally {
    globalThis.clearTimeout(timeout);
  }

  if (discovered.length > 0) return { domain, endpoints: discovered };
  return {
    domain,
    endpoints: [{ url: `wss://${domain}/xmpp-websocket`, source: 'conventional' }],
    warning: reachedMetadata ? 'no-websocket-advertised' : 'cors-or-unavailable',
  };
}

function addEndpoint(target: DiscoveredXmppEndpoint[], href: string, source: XmppEndpointSource): void {
  try {
    const url = new URL(href);
    if (url.protocol !== 'wss:' || url.username || url.password) return;
    const normalized = url.toString();
    if (!target.some((item) => item.url === normalized)) target.push({ url: normalized, source });
  } catch { /* Invalid advertisements are ignored. */ }
}
