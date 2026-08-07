import { aggregateUnread } from '../models/profiles';
import type { LocalProfile, VaultData } from '../models/types';
import type { MouseEvent } from 'react';
import { PlusIcon, RelaylessLogo, SearchIcon, UserIcon } from './icons';
import { ContextMenu, useContextMenu } from './ContextMenu';

export type ProfileScope = 'all' | string;

interface ProfileRailProps {
  data: VaultData;
  scope: ProfileScope;
  onSelect: (profileId: string) => void;
  onAll: () => void;
  onCreate: () => void;
  onReorder: (draggedId: string, targetId: string) => void;
  onPalette: () => void;
  onRename: (profile: LocalProfile) => void;
  onDelete: (profile: LocalProfile) => void;
  onExport: (profile: LocalProfile) => void;
}

export function ProfileRail({ data, scope, onSelect, onAll, onCreate, onReorder, onPalette, onRename, onDelete, onExport }: ProfileRailProps) {
  const profiles = [...data.profiles].sort((left, right) => Number(right.pinned) - Number(left.pinned) || left.order - right.order);
  const totalUnread = data.profiles.reduce((total, profile) => total + aggregateUnread(profile), 0);
  const context = useContextMenu<LocalProfile>();
  return (
    <aside className="profile-rail" aria-label="Профили">
        <button className={`profile-item brand-home ${scope === 'all' ? 'active' : ''}`} onClick={onAll} title="Все чаты" aria-label="Все чаты">
          <span className="profile-avatar"><RelaylessLogo/></span>
          {totalUnread > 0 && <b>{totalUnread > 99 ? '99+' : totalUnread}</b>}
        </button>
      <div className="profile-stack">
        {profiles.map((profile, index) => (
          <ProfileItem
            key={profile.id}
            profile={profile}
            shortcut={index + 1}
            active={scope === profile.id || (profiles.length === 1 && scope === 'all')}
            onSelect={() => onSelect(profile.id)}
            onDrop={(draggedId) => onReorder(draggedId, profile.id)}
            onContextMenu={(event) => context.open(event, profile)}
          />
        ))}
      </div>
      <div className="profile-rail-actions">
        <button onClick={onPalette} title="Поиск · Ctrl+K" aria-label="Поиск"><SearchIcon/></button>
        <button onClick={onCreate} title="Новый профиль" aria-label="Новый профиль"><PlusIcon/></button>
      </div>
      {context.menu && (
        <ContextMenu state={context.menu} onClose={context.close} items={[
          { label: 'Копировать имя', action: () => navigator.clipboard.writeText(context.menu!.value.name) },
          { label: 'Переименовать', action: () => onRename(context.menu!.value) },
          { label: 'Экспорт профиля', action: () => onExport(context.menu!.value) },
          { label: 'Удалить профиль', danger: true, disabled: data.profiles.length === 1, action: () => onDelete(context.menu!.value) },
        ]}/>
      )}
    </aside>
  );
}

function ProfileItem({ profile, shortcut, active, onSelect, onDrop, onContextMenu }: { profile: LocalProfile; shortcut: number; active: boolean; onSelect: () => void; onDrop: (draggedId: string) => void; onContextMenu: (event: MouseEvent) => void }) {
  const unread = aggregateUnread(profile);
  return (
    <button
      className={`profile-item ${active ? 'active' : ''} ${profile.locked ? 'locked' : ''}`}
      draggable
      onDragStart={(event) => event.dataTransfer.setData('text/profile-id', profile.id)}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => { event.preventDefault(); onDrop(event.dataTransfer.getData('text/profile-id')); }}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      title={`${profile.name} · Ctrl+${shortcut}`}
      aria-label={`Профиль ${profile.name}`}
    >
      <span className="profile-avatar">{profile.avatar ? <img src={profile.avatar} alt=""/> : <UserIcon/>}</span>
      {unread > 0 && <b>{unread > 99 ? '99+' : unread}</b>}
    </button>
  );
}
