import { describe, expect, it, vi } from 'vitest';
import { NetworkPolicy } from './policy';

describe('network policy', () => {
  it('records allowed user-selected XMPP connections in memory', () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001');
    const policy = new NetworkPolicy();
    const id = policy.open({ protocol: 'XMPP', destination: 'chat.example.test', port: 443, kind: 'xmpp-provider', source: 'user' });
    policy.setState(id, 'open');
    expect(policy.snapshot()[0]).toMatchObject({ destination: 'chat.example.test', state: 'open' });
  });

  it('rejects bundled XMPP destinations and invalid ports', () => {
    const policy = new NetworkPolicy();
    expect(() => policy.open({ protocol: 'XMPP', destination: 'x.test', port: 443, kind: 'xmpp-provider', source: 'distribution' })).toThrow(/selected by the user/i);
    expect(() => policy.open({ protocol: 'TOX', destination: '1.2.3.4', port: 0, kind: 'tox-peer', source: 'bundled-public-node' })).toThrow(/valid range/i);
  });
});
