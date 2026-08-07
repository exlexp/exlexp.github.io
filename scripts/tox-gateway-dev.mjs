import { createServer } from 'node:http';
import { connect } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';

const port = 8787;
const origins = new Set(['http://127.0.0.1:4173', 'http://127.0.0.1:5173', 'http://localhost:4173', 'http://localhost:5173']);
const relays = new Map([
  ['144.217.167.73', new Set([33445, 3389])],
  ['3.0.24.15', new Set([33445])],
  ['139.162.110.188', new Set([33445, 3389])],
  ['144.172.88.203', new Set([33445])],
  ['172.104.215.182', new Set([33445, 3389])],
]);
const webSockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ ok: true, protocol: 'relayless-tox-tcp-v1', relays: relays.size }));
    return;
  }
  response.writeHead(404, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ error: 'Not found' }));
});

server.on('upgrade', (request, socket, head) => {
  let url;
  try { url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`); }
  catch { socket.destroy(); return; }
  const host = url.searchParams.get('host') ?? '';
  const targetPort = Number(url.searchParams.get('port'));
  if (url.pathname !== '/v1/tcp' || !origins.has(request.headers.origin ?? '') || !relays.get(host)?.has(targetPort)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const upstream = connect({ host, port: targetPort });
  upstream.setTimeout(8_000, () => upstream.destroy(new Error('relay timeout')));
  upstream.once('error', () => {
    socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    socket.destroy();
  });
  upstream.once('connect', () => {
    upstream.setTimeout(0);
    webSockets.handleUpgrade(request, socket, head, (webSocket) => bridge(webSocket, upstream));
  });
});

function bridge(webSocket, upstream) {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (webSocket.readyState < WebSocket.CLOSING) webSocket.close();
    upstream.destroy();
  };
  webSocket.on('message', (data, binary) => {
    if (!binary) { close(); return; }
    if (!upstream.write(data)) webSocket.pause();
  });
  upstream.on('drain', () => webSocket.resume());
  upstream.on('data', (data) => {
    if (webSocket.readyState === WebSocket.OPEN) webSocket.send(data, { binary: true });
  });
  webSocket.on('close', close);
  webSocket.on('error', close);
  upstream.on('close', close);
  upstream.on('error', close);
}

server.listen(port, '127.0.0.1', () => console.log(`Tox gateway ready on ws://127.0.0.1:${port}/v1/tcp`));
