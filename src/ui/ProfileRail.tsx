import { aggregateUnread } from '../models/profiles';
import type { LocalProfile, VaultData } from '../models/types';
import { InboxIcon, PlusIcon, SearchIcon, UserIcon } from './icons';

export type ProfileScope = 'all' | string;

interface ProfileRailProps {
  data: VaultData;
  scope: ProfileScope;
  onSelect: (profileId: string) => void;
  onAll: () => void;
  onCreate: () => void;
  onReorder: (draggedId: string, targetId: string) => void;
  onPalette: () => void;
}

export function ProfileRail({ data, scope, onSelect, onAll, onCreate, onReorder, onPalette }: ProfileRailProps) {
  const profiles = [...data.profiles].sort((left, right) => Number(right.pinned) - Number(left.pinned) || left.order - right.order);
  const totalUnread = data.profiles.reduce((total, profile) => total + aggregateUnread(profile), 0);
  return (
    <aside className="profile-rail" aria-label="Профили">
      {profiles.length > 1 && (
        <button className={`profile-item all-inboxes ${scope === 'all' ? 'active' : ''}`} onClick={onAll} title="Все чаты" aria-label="Все чаты">
          <span className="profile-avatar"><InboxIcon/></span>
          {totalUnread > 0 && <b>{totalUnread > 99 ? '99+' : totalUnread}</b>}
        </button>
      )}
      <div className="profile-stack">
        {profiles.map((profile, index) => (
          <ProfileItem
            key={profile.id}
            profile={profile}
            shortcut={index + 1}
            active={scope === profile.id || (profiles.length === 1 && scope === 'all')}
            onSelect={() => onSelect(profile.id)}
            onDrop={(draggedId) => onReorder(draggedId, profile.id)}
          />
        ))}
      </div>
      <div className="profile-rail-actions">
        <button onClick={onPalette} title="Поиск · Ctrl+K" aria-label="Поиск"><SearchIcon/></button>
        <button onClick={onCreate} title="Новый профиль" aria-label="Новый профиль"><PlusIcon/></button>
      </div>
    </aside>
  );
}

function ProfileItem({ profile, shortcut, active, onSelect, onDrop }: { profile: LocalProfile; shortcut: number; active: boolean; onSelect: () => void; onDrop: (draggedId: string) => void }) {
  const unread = aggregateUnread(profile);
  return (
    <button
      className={`profile-item ${active ? 'active' : ''} ${profile.locked ? 'locked' : ''}`}
      draggable
      onDragStart={(event) => event.dataTransfer.setData('text/profile-id', profile.id)}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => { event.preventDefault(); onDrop(event.dataTransfer.getData('text/profile-id')); }}
      onClick={onSelect}
      title={`${profile.name} · Ctrl+${shortcut}`}
      aria-label={`Профиль ${profile.name}`}
    >
      <span className="profile-avatar">{profile.avatar ? <img src={profile.avatar} alt=""/> : <UserIcon/>}</span>
      {unread > 0 && <b>{unread > 99 ? '99+' : unread}</b>}
    </button>
  );
}
