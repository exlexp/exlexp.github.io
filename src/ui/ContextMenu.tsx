import { useEffect, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';

export interface ContextMenuItem {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  action: () => void | Promise<void>;
}

export interface ContextMenuState<T> {
  value: T;
  x: number;
  y: number;
}

export function useContextMenu<T>() {
  const [menu, setMenu] = useState<ContextMenuState<T>>();
  const open = (event: ReactMouseEvent, value: T) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ value, x: event.clientX, y: event.clientY });
  };
  return { menu, open, close: () => setMenu(undefined) };
}

export function ContextMenu({ state, items, onClose }: { state: ContextMenuState<unknown>; items: ContextMenuItem[]; onClose: () => void }) {
  useEffect(() => {
    const close = () => onClose();
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);
  const x = Math.max(8, Math.min(state.x, window.innerWidth - 224));
  const y = Math.max(8, Math.min(state.y, window.innerHeight - Math.max(64, items.length * 42 + 16)));
  return <div className="context-menu" role="menu" style={{ left: x, top: y }} onPointerDown={(event) => event.stopPropagation()} onContextMenu={(event) => event.preventDefault()}>{items.map((item, index) => <button role="menuitem" type="button" className={item.danger ? 'danger' : ''} disabled={item.disabled} key={`${item.label}:${index}`} onClick={() => { onClose(); void item.action(); }}>{item.icon && <span>{item.icon}</span>}<span>{item.label}</span></button>)}</div>;
}
