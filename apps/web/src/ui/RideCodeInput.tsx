import type { ChangeEvent, KeyboardEvent } from 'react';
import { cx } from './cx';
import styles from './RideCodeInput.module.css';
import { extractRideCode, formatPartialCode, hasLookalikes } from './rideCode';

interface RideCodeInputProps {
  /** Normalized code, 0–6 characters. */
  value: string;
  onChange: (code: string, info: { lookalikes: boolean }) => void;
  onSubmit?: () => void;
  invalid?: boolean;
  id?: string;
  label?: string;
  describedBy?: string;
  testId?: string;
}

/**
 * One wide monospace field for the 6-character code. Accepts any case and separators
 * ("abc-d23", "ABC D23") and whole join links, and shows the code grouped as ABC-D23.
 */
export function RideCodeInput({
  value,
  onChange,
  onSubmit,
  invalid = false,
  id,
  label = 'Ride code',
  describedBy,
  testId,
}: RideCodeInputProps) {
  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    const raw = e.currentTarget.value;
    onChange(extractRideCode(raw), { lookalikes: hasLookalikes(raw) });
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      onSubmit?.();
    }
  }

  return (
    <input
      id={id}
      className={cx(styles.input, invalid && styles.invalid)}
      type="text"
      inputMode="text"
      autoCapitalize="characters"
      autoComplete="off"
      autoCorrect="off"
      spellCheck={false}
      enterKeyHint="go"
      placeholder="XXX-XXX"
      aria-label={label}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      data-testid={testId}
      value={formatPartialCode(value)}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
    />
  );
}
