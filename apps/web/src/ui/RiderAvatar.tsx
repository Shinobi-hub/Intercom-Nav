import type { CSSProperties } from 'react';
import { initials } from '../core/format';
import { inkOn } from './color';
import { cx } from './cx';
import styles from './RiderAvatar.module.css';

interface RiderAvatarProps {
  name: string;
  color: string;
  size?: 'sm' | 'md' | 'lg';
  /** Green ring while this rider is talking. */
  speaking?: boolean;
  /** Faded when the rider is offline or their position is stale. */
  dim?: boolean;
  className?: string;
}

export function RiderAvatar({ name, color, size = 'md', speaking = false, dim = false, className }: RiderAvatarProps) {
  return (
    <span
      className={cx(styles.avatar, styles[size], dim && styles.dim, className)}
      style={{ '--c': color, '--c-ink': inkOn(color) } as CSSProperties}
      data-speaking={speaking}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}
