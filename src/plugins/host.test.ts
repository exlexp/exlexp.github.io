import { describe, expect, it } from 'vitest';
import { availablePluginCommands, installPlugin, parsePluginManifest } from './host';

const source = JSON.stringify({
  apiVersion: 1,
  id: 'org.example.focus',
  name: 'Focus',
  version: '1.0.0',
  description: 'Opens the chat list.',
  permissions: ['commands'],
  commands: [{ id: 'open', title: 'Open chats', action: 'open-chats' }],
});

describe('safe plugin manifests', () => {
  it('installs declarative plugins with explicit permissions', () => {
    const manifest = parsePluginManifest(source);
    const installed = installPlugin(manifest, ['commands'], []);
    expect(availablePluginCommands(installed)).toEqual([{ id: 'open', title: 'Open chats', action: 'open-chats', pluginId: 'org.example.focus' }]);
  });

  it('rejects executable URLs and unknown permissions', () => {
    expect(() => parsePluginManifest(JSON.stringify({ ...JSON.parse(source), permissions: ['network'] }))).toThrow(/unknown permission/i);
    expect(() => parsePluginManifest(JSON.stringify({ ...JSON.parse(source), commands: [{ id: 'x', title: 'X', action: 'https://example.test' }] }))).toThrow(/invalid command/i);
  });
});
