import type { ReactNode } from 'react';
import { tapFeedback } from './feedback';
import styles from './Toggle.module.css';

interface ToggleProps {
  label: string;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  testId?: string;
  disabled?: boolean;
}

/** A full-width switch row: the whole row is the target, not just the little track. */
export function Toggle({ label, description, checked, onChange, testId, disabled }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={styles.row}
      data-testid={testId}
      data-state={checked ? 'on' : 'off'}
      onClick={() => {
        tapFeedback();
        onChange(!checked);
      }}
    >
      <span className={styles.text}>
        <span className={styles.label}>{label}</span>
        {description && <span className={styles.description}>{description}</span>}
      </span>
      <span className={styles.track} aria-hidden="true">
        <span className={styles.thumb} />
      </span>
    </button>
  );
}
