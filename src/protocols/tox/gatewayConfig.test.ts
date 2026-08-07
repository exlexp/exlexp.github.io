import { describe, expect, it } from 'vitest';
import { parseGatewayList } from './gatewayConfig';

describe('Tox gateway configuration', () => {
  it('accepts secure endpoints and loopback development endpoints only', () => {
    expect(parseGatewayList('wss://gateway.example/v1/tcp, ws://127.0.0.1:8787/v1/tcp, ws://remote.example/socket')).toEqual([
      'wss://gateway.example/v1/tcp',
      'ws://127.0.0.1:8787/v1/tcp',
    ]);
  });

  it('deduplicates and ignores malformed values', () => {
    expect(parseGatewayList('invalid,wss://gateway.example/v1/tcp,wss://gateway.example/v1/tcp')).toEqual([
      'wss://gateway.example/v1/tcp',
    ]);
  });
});
