export type FetchPurpose = 'bundled-asset' | 'xmpp-discovery';
export type WebSocketPurpose = 'tox-gateway' | 'xmpp-provider';

/**
 * The only browser transport entry points used outside the Tox worker.
 * Keeping these primitives centralized makes accidental telemetry and
 * credential-bearing cross-origin requests visible to the privacy audit.
 */
export function privateFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  purpose: FetchPurpose,
  implementation: typeof fetch = globalThis.fetch,
): Promise<Response> {
  const url = normalizedUrl(input);
  if (url.username || url.password) throw new Error('Credentials in network URLs are forbidden');
  if (purpose === 'bundled-asset') {
    const origin = globalThis.location?.origin;
    if (!origin || url.origin !== origin) throw new Error('Bundled assets must stay on the application origin');
  } else if (url.protocol !== 'https:') {
    throw new Error('XMPP discovery requires HTTPS');
  }
  return implementation(input, {
    ...init,
    credentials: purpose === 'bundled-asset' ? 'same-origin' : 'omit',
    referrerPolicy: 'no-referrer',
  });
}

export function privateWebSocket(
  input: string | URL,
  protocols: string | string[] | undefined,
  purpose: WebSocketPurpose,
): WebSocket {
  const url = normalizedUrl(input);
  if (url.username || url.password || url.hash) throw new Error('Unsafe WebSocket URL');
  const localDevelopment = url.protocol === 'ws:' && isLoopback(url.hostname);
  if (url.protocol !== 'wss:' && !(purpose === 'tox-gateway' && localDevelopment)) {
    throw new Error('Network connections require secure WebSockets');
  }
  const normalized = url.toString();
  return protocols === undefined ? new WebSocket(normalized) : new WebSocket(normalized, protocols);
}

function normalizedUrl(input: RequestInfo | URL): URL {
  const raw = input instanceof Request ? input.url : input.toString();
  const base = globalThis.location?.href ?? 'https://relayless.invalid/';
  return new URL(raw, base);
}

function isLoopback(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}
