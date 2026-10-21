import { CircleAlert } from 'lucide-react';
import { TID } from '../../core/testIds';
import styles from './start.module.css';

/** Inline failure for create/join/rejoin; one per screen at most. */
export function ErrorText({ children }: { children: string }) {
  return (
    <p className={styles.error} role="alert" data-testid={TID.joinError}>
      <CircleAlert className={styles.errorIcon} aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}
