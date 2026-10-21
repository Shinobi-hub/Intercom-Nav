import { cx } from './cx';
import styles from './HoldRing.module.css';

interface HoldRingProps {
  /** While true the ring fills over `durationMs`; false snaps it back to empty. */
  active: boolean;
  durationMs: number;
  size?: number;
  className?: string;
}

/** Circular progress for hold-to-confirm. Driven by CSS so it stays smooth on a busy main thread. */
export function HoldRing({ active, durationMs, size = 64, className }: HoldRingProps) {
  return (
    <svg
      // allow-motion: this ring is the only cue that a hold is counting, so it keeps animating
      // under prefers-reduced-motion.
      className={cx(styles.ring, 'allow-motion', className)}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden="true"
      data-active={active}
    >
      <circle className={styles.track} cx="32" cy="32" r="29" pathLength={100} />
      <circle
        className={styles.fill}
        cx="32"
        cy="32"
        r="29"
        pathLength={100}
        style={{ animationDuration: `${durationMs}ms` }}
      />
    </svg>
  );
}
