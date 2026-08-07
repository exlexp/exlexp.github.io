import { useEffect, useMemo, useRef, useState } from 'react';
import type { LocalProfile, PluginCommand } from '../models/types';
import type { ProfileScope } from './ProfileRail';

interface CommandPaletteProps {
  open: boolean;
  profiles: LocalProfile[];
  pluginCommands: Array<PluginCommand & { pluginId: string }>;
  onPluginCommand: (action: PluginCommand['action']) => void;
  onClose: () => void;
  onProfile: (profileId: string) => void;
  onScope: (scope: ProfileScope) => void;
  onCreate: () => void;
}

export function CommandPalette({ open, profiles, pluginCommands, onPluginCommand, onClose, onProfile, onScope, onCreate }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setQuery(''); queueMicrotask(() => input.current?.focus()); } }, [open]);
  const items = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return profiles.filter((profile) => profile.name.toLowerCase().includes(normalized));
  }, [profiles, query]);
  if (!open) return null;
  return (
    <div className="palette-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <header><input ref={input} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }} placeholder="Найти профиль"/></header>
        <div className="palette-section"><button onClick={() => { onScope('all'); onClose(); }}><span>Все чаты</span></button><button onClick={() => { onCreate(); onClose(); }}><span>Новый профиль</span></button></div>
        <div className="palette-section">{items.map((profile) => <button key={profile.id} onClick={() => { onProfile(profile.id); onClose(); }}><span>{profile.name}</span></button>)}{items.length === 0 && <p>Ничего не найдено</p>}</div>
        {pluginCommands.length > 0 && <div className="palette-section plugin-commands">{pluginCommands.map((command) => <button key={`${command.pluginId}:${command.id}`} onClick={() => { onPluginCommand(command.action); onClose(); }}><span>{command.title}</span></button>)}</div>}
      </section>
    </div>
  );
}
