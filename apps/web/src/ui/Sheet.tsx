import { X } from 'lucide-react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { TID } from '../core/testIds';
import { tapFeedback } from './feedback';
import styles from './Sheet.module.css';

interface SheetProps {
  /** Becomes data-testid "sheet-<id>". */
  id: string;
  title: string;
  onClose: () => void;
  children: ReactNode;
}

const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * Bottom sheet. Closes with the big close button, a tap on the scrim, or Escape; there is
 * deliberately no swipe-to-dismiss (gloves, vibration). Focus is trapped while open and returned on close.
 */
export function Sheet({ id, title, onClose, children }: SheetProps) {
  const titleId = useId();
  const panel = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus({ preventScroll: true });
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  function trapTab(e: KeyboardEvent<HTMLElement>) {
    if (e.key !== 'Tab' || !panel.current) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return createPortal(
    <div className={styles.root}>
      <div className={styles.scrim} onClick={onClose} aria-hidden="true" />
      <section
        ref={panel}
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid={TID.sheet(id)}
        onKeyDown={trapTab}
      >
        <header className={styles.header}>
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
          <button
            type="button"
            className={styles.close}
            data-testid={TID.sheetClose}
            aria-label={`Close ${title}`}
            onClick={() => {
              tapFeedback();
              onClose();
            }}
          >
            <X aria-hidden="true" />
          </button>
        </header>
        <div className={styles.body}>{children}</div>
      </section>
    </div>,
    document.body,
  );
}
