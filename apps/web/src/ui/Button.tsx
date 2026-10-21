import type { LucideIcon } from 'lucide-react';
import type { ComponentPropsWithRef, MouseEvent } from 'react';
import styles from './Button.module.css';
import { cx } from './cx';
import { tapFeedback } from './feedback';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'ok' | 'light' | 'outline';

export interface ButtonProps extends ComponentPropsWithRef<'button'> {
  variant?: ButtonVariant;
  /** md = 56 px (secondary), lg = 76 px (primary actions). */
  size?: 'md' | 'lg';
  icon?: LucideIcon;
  /** Shows a spinner in place of the icon and blocks presses. */
  busy?: boolean;
  /** Stretch to the container width. */
  block?: boolean;
  /** Set false when the handler must run something else first (audio unlock) and plays feedback itself. */
  feedback?: boolean;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  busy = false,
  block = false,
  feedback = true,
  className,
  children,
  onClick,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  function handleClick(e: MouseEvent<HTMLButtonElement>) {
    if (busy) return;
    if (feedback) tapFeedback();
    onClick?.(e);
  }

  return (
    <button
      type={type}
      className={cx(styles.button, styles[variant], styles[size], block && styles.block, className)}
      disabled={disabled}
      aria-busy={busy || undefined}
      onClick={handleClick}
      {...rest}
    >
      {busy ? <Spinner size={size === 'lg' ? 26 : 22} /> : Icon && <Icon className={styles.icon} aria-hidden="true" />}
      {children !== undefined && <span className={styles.label}>{children}</span>}
    </button>
  );
}
