import { hasDirectSockets } from '../../network/directSockets';

const configuredGateways = parseGatewayList(import.meta.env.VITE_TOX_GATEWAY_URLS ?? '');

export function toxGatewayUrls(): string[] {
  if (configuredGateways.length) return [...configuredGateways];
  if (import.meta.env.DEV) return ['ws://127.0.0.1:8787/v1/tcp'];
  return [];
}

export function hasToxTransport(): boolean {
  return hasDirectSockets() || toxGatewayUrls().length > 0;
}

export function parseGatewayList(value: string): string[] {
  const result: string[] = [];
  for (const candidate of value.split(',').map((item) => item.trim()).filter(Boolean)) {
    try {
      const url = new URL(candidate);
      const localInsecure = url.protocol === 'ws:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
      if (url.protocol !== 'wss:' && !localInsecure) continue;
      url.hash = '';
      result.push(url.toString());
    } catch { /* invalid entries are ignored */ }
  }
  return [...new Set(result)];
}
