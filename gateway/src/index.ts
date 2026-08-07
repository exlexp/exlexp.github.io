import { connect } from 'cloudflare:sockets';

interface Env {
  ALLOWED_ORIGINS?: string;
}

interface RelayTarget {
  host: string;
  ports: readonly number[];
}

const RELAYS: readonly RelayTarget[] = [
  { host: '144.217.167.73', ports: [33445, 3389] },
  { host: '3.0.24.15', ports: [33445] },
  { host: '139.162.110.188', ports: [33445, 3389] },
  { host: '144.172.88.203', ports: [33445] },
  { host: '172.104.215.182', ports: [33445, 3389] },
] as const;

const DEFAULT_ORIGINS = [
  'https://exlexp.github.io',
  'http://127.0.0.1:4173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://localhost:5173',
];
const MAX_BUFFERED_BYTES = 1024 * 1024;
const RELAY_OPEN_TIMEOUT_MS = 8_000;
const OPEN_ATTEMPTS_PER_MINUTE = 30;
const recentConnections = new Map<string, number[]>();
const rateLimitSalt = crypto.getRandomValues(new Uint8Array(32));

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, protocol: 'relayless-tox-tcp-v1', relays: RELAYS.length });
    }
    if (request.method !== 'GET' || url.pathname !== '/v1/tcp') return json({ error: 'Not found' }, 404);
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'WebSocket upgrade required' }, 426);
    if (!originAllowed(request.headers.get('Origin'), env.ALLOWED_ORIGINS)) return json({ error: 'Origin denied' }, 403);

    const host = url.searchParams.get('host') ?? '';
    const port = Number(url.searchParams.get('port'));
    if (!relayAllowed(host, port)) return json({ error: 'Relay denied' }, 403);

    const clientAddress = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    const connectionKey = await pseudonymousConnectionKey(clientAddress);
    if (!allowConnection(connectionKey)) return json({ error: 'Too many connections' }, 429);

    let tcp: Socket | undefined;
    try {
      tcp = connect({ hostname: host, port }, { allowHalfOpen: false });
      await withTimeout(tcp.opened, RELAY_OPEN_TIMEOUT_MS);
    } catch {
      if (tcp) void tcp.close().catch(() => undefined);
      return json({ error: 'Relay unavailable' }, 502);
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept({ allowHalfOpen: true });
    bridge(server, tcp);
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: privacyHeaders({ 'X-Relayless-Protocol': 'tox-tcp-v1' }),
    });
  },
};

function bridge(webSocket: WebSocket, tcp: Socket): void {
  const writer = tcp.writable.getWriter();
  let writeChain = Promise.resolve();
  let closed = false;
  let queuedWriteBytes = 0;

  const close = (code = 1000, reason = 'closed') => {
    if (closed) return;
    closed = true;
    try { webSocket.close(code, reason.slice(0, 120)); } catch { /* already closed */ }
    void writer.abort().catch(() => undefined);
    void tcp.close();
  };

  webSocket.addEventListener('message', (event) => {
    if (closed || typeof event.data === 'string') { close(1003, 'binary frames required'); return; }
    const announcedBytes = event.data instanceof ArrayBuffer ? event.data.byteLength : event.data.size;
    if (announcedBytes > MAX_BUFFERED_BYTES || queuedWriteBytes + announcedBytes > MAX_BUFFERED_BYTES) {
      close(1009, 'relay buffer limit exceeded');
      return;
    }
    queuedWriteBytes += announcedBytes;
    writeChain = writeChain
      .then(async () => {
        const bytes = event.data instanceof ArrayBuffer
          ? new Uint8Array(event.data)
          : new Uint8Array(await event.data.arrayBuffer());
        await writer.write(bytes);
      })
      .finally(() => { queuedWriteBytes = Math.max(0, queuedWriteBytes - announcedBytes); })
      .catch(() => close(1011, 'relay write failed'));
  });
  webSocket.addEventListener('close', () => close());
  webSocket.addEventListener('error', () => close(1011, 'websocket failed'));

  void (async () => {
    const reader = tcp.readable.getReader();
    try {
      while (!closed) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.byteLength) {
          if (webSocket.bufferedAmount > MAX_BUFFERED_BYTES) throw new Error('websocket buffer limit exceeded');
          webSocket.send(value);
        }
      }
      close();
    } catch {
      close(1011, 'relay read failed');
    } finally {
      reader.releaseLock();
    }
  })();
}

function relayAllowed(host: string, port: number): boolean {
  return Number.isInteger(port) && RELAYS.some((relay) => relay.host === host && relay.ports.includes(port));
}

function originAllowed(origin: string | null, configured?: string): boolean {
  if (!origin) return false;
  const allowed = configured?.split(',').map((value) => value.trim()).filter(Boolean) ?? DEFAULT_ORIGINS;
  return allowed.includes(origin);
}

function allowConnection(address: string): boolean {
  const now = Date.now();
  const cutoff = now - 60_000;
  const entries = (recentConnections.get(address) ?? []).filter((value) => value > cutoff);
  if (entries.length >= OPEN_ATTEMPTS_PER_MINUTE) return false;
  entries.push(now);
  recentConnections.set(address, entries);
  if (recentConnections.size > 10_000) {
    for (const [key, values] of recentConnections) {
      if (values.every((value) => value <= cutoff)) recentConnections.delete(key);
    }
  }
  return true;
}

async function pseudonymousConnectionKey(address: string): Promise<string> {
  const encoded = new TextEncoder().encode(address);
  const input = new Uint8Array(rateLimitSalt.byteLength + encoded.byteLength);
  input.set(rateLimitSalt);
  input.set(encoded, rateLimitSalt.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: privacyHeaders() });
}

function privacyHeaders(extra: Record<string, string> = {}): Headers {
  return new Headers({
    'Cache-Control': 'no-store, max-age=0',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  });
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    operation.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}
