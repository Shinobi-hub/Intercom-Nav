import type { LucideIcon } from 'lucide-react';
import { cx } from './cx';
import { tapFeedback, tickFeedback } from './feedback';
import styles from './HoldButton.module.css';
import { HoldRing } from './HoldRing';
import { usePress } from './usePress';

interface HoldButtonProps {
  label: string;
  /** Shown while the hold is counting. */
  holdingLabel?: string;
  durationMs: number;
  onConfirm: () => void;
  icon?: LucideIcon;
  testId?: string;
  className?: string;
  disabled?: boolean;
}

/** A secondary hold-to-confirm control (e.g. cancelling an SOS): ring + label, 56 px tall. */
export function HoldButton({
  label,
  holdingLabel = 'Keep holding…',
  durationMs,
  onConfirm,
  icon: Icon,
  testId,
  className,
  disabled,
}: HoldButtonProps) {
  const { pressing, bind } = usePress({
    holdMs: durationMs,
    onPressStart: tapFeedback,
    onTick: tickFeedback,
    onHold: onConfirm,
    disabled,
  });

  return (
    <button
      type="button"
      className={cx(styles.button, className)}
      data-testid={testId}
      data-holding={pressing}
      aria-disabled={disabled || undefined}
      aria-description={`Hold for ${(durationMs / 1000).toFixed(1)} seconds`}
      {...bind}
    >
      <span className={styles.dial}>
        <HoldRing active={pressing} durationMs={durationMs} size={40} />
        {Icon && <Icon className={styles.icon} aria-hidden="true" />}
      </span>
      <span className={styles.label}>{pressing ? holdingLabel : label}</span>
    </button>
  );
}
