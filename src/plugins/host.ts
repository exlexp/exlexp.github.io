import type { InstalledPlugin, PluginCommand, PluginManifest, PluginPermission } from '../models/types';

const permissions = new Set<PluginPermission>(['commands', 'message-metadata', 'contacts-summary']);
const actions = new Set<PluginCommand['action']>(['open-chats', 'open-accounts', 'open-contacts', 'open-settings']);

export function parsePluginManifest(source: string): PluginManifest {
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new Error('Plugin manifest must be valid JSON'); }
  if (!value || typeof value !== 'object') throw new Error('Plugin manifest must be an object');
  const item = value as Partial<PluginManifest>;
  if (item.apiVersion !== 1) throw new Error('Unsupported plugin API version');
  if (!item.id || !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(item.id)) throw new Error('Plugin id must use reverse-domain notation');
  if (!item.name?.trim() || item.name.length > 60) throw new Error('Plugin name is required and must be at most 60 characters');
  if (!item.version || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(item.version)) throw new Error('Plugin version must use semantic versioning');
  if (typeof item.description !== 'string' || item.description.length > 240) throw new Error('Plugin description must be at most 240 characters');
  if (!Array.isArray(item.permissions) || item.permissions.some((permission) => !permissions.has(permission))) throw new Error('Plugin requests an unknown permission');
  if (item.commands !== undefined && (!Array.isArray(item.commands) || item.commands.some((command) => !validCommand(command)))) throw new Error('Plugin contains an invalid command');
  return structuredClone(item as PluginManifest);
}

export function installPlugin(manifest: PluginManifest, grantedPermissions: PluginPermission[], existing: InstalledPlugin[]): InstalledPlugin[] {
  if (existing.some((plugin) => plugin.manifest.id === manifest.id)) throw new Error('Plugin is already installed');
  if (grantedPermissions.some((permission) => !manifest.permissions.includes(permission))) throw new Error('Cannot grant a permission the plugin did not request');
  return [...existing, { manifest: structuredClone(manifest), enabled: true, grantedPermissions: [...grantedPermissions], installedAt: Date.now() }];
}

export function availablePluginCommands(plugins: InstalledPlugin[]): Array<PluginCommand & { pluginId: string }> {
  return plugins.flatMap((plugin) => plugin.enabled && plugin.grantedPermissions.includes('commands')
    ? (plugin.manifest.commands ?? []).map((command) => ({ ...command, pluginId: plugin.manifest.id }))
    : []);
}

function validCommand(value: unknown): value is PluginCommand {
  if (!value || typeof value !== 'object') return false;
  const command = value as Partial<PluginCommand>;
  return Boolean(command.id && /^[a-z0-9-]+$/.test(command.id) && command.title?.trim() && command.title.length <= 80 && command.action && actions.has(command.action));
}
