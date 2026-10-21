import type { LucideIcon } from 'lucide-react';
import { ListMusic, QrCode, Route, Settings, Users } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { SheetId } from '../../../core/store';
import { useLocalStore, useRideStore } from '../../../core/store';
import { TID } from '../../../core/testIds';
import { tapFeedback } from '../../../ui/feedback';
import styles from './dock.module.css';

const ITEMS: ReadonlyArray<{ id: SheetId; label: string; icon: LucideIcon }> = [
  { id: 'route', label: 'Route', icon: Route },
  { id: 'riders', label: 'Riders', icon: Users },
  { id: 'music', label: 'Music', icon: ListMusic },
  { id: 'settings', label: 'Settings', icon: Settings },
  { id: 'share', label: 'Share ride', icon: QrCode },
];

/** The More menu: big rows above the dock (beside it in landscape). */
export function MoreMenu({ onClose }: { onClose: () => void }) {
  const menu = useRef<HTMLDivElement>(null);
  const onlineCount = useRideStore((s) => Object.values(s.riders).filter((r) => r.online).length);
  const destination = useRideStore((s) => s.route?.destination.name ?? null);

  useEffect(() => {
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!step || !menu.current) return;
    e.preventDefault();
    const items = [...menu.current.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + step + items.length) % items.length]?.focus();
  }

  const meta: Partial<Record<SheetId, string>> = {
    riders: String(onlineCount),
    ...(destination ? { route: destination } : {}),
  };

  return createPortal(
    <div className={styles.menuRoot}>
      <div className={styles.menuScrim} onClick={onClose} aria-hidden="true" />
      <div ref={menu} role="menu" aria-label="More" className={styles.menu} onKeyDown={onKeyDown}>
        {ITEMS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="menuitem"
            className={styles.item}
            data-testid={TID.menuItem(id)}
            onClick={() => {
              tapFeedback();
              onClose();
              useLocalStore.getState().openSheet(id);
            }}
          >
            <Icon className={styles.itemIcon} aria-hidden="true" />
            <span className={styles.itemLabel}>{label}</span>
            {meta[id] && <span className={styles.itemMeta}>{meta[id]}</span>}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}
