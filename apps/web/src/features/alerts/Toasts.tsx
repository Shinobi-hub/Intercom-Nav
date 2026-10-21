import type { LucideIcon } from 'lucide-react';
import { CircleAlert, CircleCheck, Coffee, Info, Siren, TriangleAlert } from 'lucide-react';
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { Toast } from '../../core/store';
import { useLocalStore, useRideStore } from '../../core/store';
import { TID } from '../../core/testIds';
import { RiderAvatar } from '../../ui/RiderAvatar';
import styles from './Toasts.module.css';

const ICONS: Record<Toast['kind'], LucideIcon> = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  error: CircleAlert,
  break: Coffee,
  sos: Siren,
};

/** Notifications at the top of the screen: big text, auto-dismiss after ttlMs, tap to dismiss. */
export function Toasts() {
  const toasts = useLocalStore((s) => s.ui.toasts);
  if (toasts.length === 0) return null;
  // Newest first, nearest the top edge where the eye lands.
  return createPortal(
    <div className={styles.stack} role="status" aria-live="polite">
      {[...toasts].reverse().map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>,
    document.body,
  );
}

function ToastItem({ toast }: { toast: Toast }) {
  const rider = useRideStore((s) => (toast.riderId ? s.riders[toast.riderId] : undefined));
  const dismiss = () => useLocalStore.getState().dismissToast(toast.id);

  useEffect(() => {
    if (toast.ttlMs <= 0) return;
    const remaining = toast.createdAt + toast.ttlMs - Date.now();
    const timer = setTimeout(() => useLocalStore.getState().dismissToast(toast.id), Math.max(0, remaining));
    return () => clearTimeout(timer);
  }, [toast.id, toast.createdAt, toast.ttlMs]);

  const Icon = ICONS[toast.kind];
  return (
    <button
      type="button"
      className={styles.toast}
      data-testid={TID.toast}
      data-kind={toast.kind}
      aria-label={`${toast.title}${toast.body ? `. ${toast.body}` : ''}. Tap to dismiss.`}
      onClick={dismiss}
    >
      <span className={styles.badge} aria-hidden="true">
        <Icon className={styles.icon} />
      </span>
      <span className={styles.text}>
        <span className={styles.title}>{toast.title}</span>
        {toast.body && <span className={styles.body}>{toast.body}</span>}
      </span>
      {rider && <RiderAvatar name={rider.name} color={rider.color} size="sm" className={styles.rider} />}
    </button>
  );
}
