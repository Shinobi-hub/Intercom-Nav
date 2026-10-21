import type { ChangeEvent, CSSProperties, FormEvent, ReactNode } from 'react';
import { useId } from 'react';
import { cx } from './cx';
import { tapFeedback } from './feedback';
import styles from './Slider.module.css';

interface SliderProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  format?: (value: number) => string;
  hint?: ReactNode;
  /** One row: the label is for screen readers only and the value sits after the track. */
  inline?: boolean;
  testId?: string;
  disabled?: boolean;
  className?: string;
}

const percent = (v: number) => `${Math.round(v * 100)}%`;

/** Labelled range input with a large thumb and a 56 px tall hit area. */
export function Slider({
  label,
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.05,
  format = percent,
  hint,
  inline = false,
  testId,
  disabled,
  className,
}: SliderProps) {
  const id = useId();
  const progress = max > min ? (value - min) / (max - min) : 0;

  // onInput as well as onChange: tools that set .value and dispatch a bare 'input' event
  // (e.g. Playwright's fill) bypass React's change tracking, and both paths are idempotent.
  function handle(e: ChangeEvent<HTMLInputElement> | FormEvent<HTMLInputElement>) {
    const next = Number(e.currentTarget.value);
    if (Number.isFinite(next) && next !== value) onChange(next);
  }

  const input = (
    <input
      id={id}
      className={styles.input}
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      data-testid={testId}
      aria-valuetext={format(value)}
      style={{ '--p': String(Math.min(1, Math.max(0, progress))) } as CSSProperties}
      onChange={handle}
      onInput={handle}
      onPointerUp={tapFeedback}
    />
  );
  const output = (
    <output htmlFor={id} className={styles.value}>
      {format(value)}
    </output>
  );

  if (inline) {
    return (
      <div className={cx(styles.inline, className)}>
        <label htmlFor={id} className="sr-only">
          {label}
        </label>
        {input}
        {output}
      </div>
    );
  }

  return (
    <div className={cx(styles.root, className)}>
      <div className={styles.row}>
        <label htmlFor={id} className={styles.label}>
          {label}
        </label>
        {output}
      </div>
      {input}
      {hint && <div className={styles.hint}>{hint}</div>}
    </div>
  );
}
