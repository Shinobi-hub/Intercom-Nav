import type { LucideIcon } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { useRef } from 'react';
import { cx } from './cx';
import { tapFeedback } from './feedback';
import styles from './Segmented.module.css';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
  testId?: string;
}

interface SegmentedProps<T extends string> {
  /** Accessible name of the group. */
  label: string;
  value: T;
  options: ReadonlyArray<SegmentedOption<T>>;
  onChange: (value: T) => void;
  /** On the group; the current value is mirrored in data-value. */
  testId?: string;
  disabled?: boolean;
}

/** Radio group drawn as one row of large segments. Arrow keys move the selection. */
export function Segmented<T extends string>({ label, value, options, onChange, testId, disabled }: SegmentedProps<T>) {
  const group = useRef<HTMLDivElement>(null);

  function select(next: T) {
    if (disabled) return;
    tapFeedback();
    if (next !== value) onChange(next);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const i = options.findIndex((o) => o.value === value);
    const next = options[(i + step + options.length) % options.length]!;
    select(next.value);
    group.current?.querySelector<HTMLElement>(`[data-value="${next.value}"]`)?.focus();
  }

  return (
    <div
      ref={group}
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      className={styles.group}
      data-testid={testId}
      data-value={value}
      onKeyDown={onKeyDown}
    >
      {options.map(({ value: v, label: text, icon: Icon, testId: optionTestId }) => {
        const checked = v === value;
        return (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            disabled={disabled}
            className={cx(styles.option, checked && styles.checked)}
            data-testid={optionTestId}
            data-value={v}
            onClick={() => select(v)}
          >
            {Icon && <Icon className={styles.icon} aria-hidden="true" />}
            <span>{text}</span>
          </button>
        );
      })}
    </div>
  );
}
