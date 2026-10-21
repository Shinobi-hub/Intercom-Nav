import type { ComponentPropsWithRef, ReactNode } from 'react';
import { cx } from '../../../ui/cx';
import styles from './dock.module.css';

export type DockTone = 'mic-vox' | 'mic-open' | 'mic-off' | 'music' | 'break' | 'sos' | 'neutral';

interface DockKeyProps extends Omit<ComponentPropsWithRef<'button'>, 'children'> {
  tone: DockTone;
  /** Lamp on: the function is active (mic live, music playing, break sent, SOS). */
  lit: boolean;
  glyph: ReactNode;
  caption: ReactNode;
  captionClassName?: string;
  /** Extra content under the caption (e.g. the cooldown meter). */
  children?: ReactNode;
}

/** One key of the dock: a status lamp, a glyph and a caption, in a ≥76 px cell. */
export function DockKey({ tone, lit, glyph, caption, captionClassName, className, children, ...rest }: DockKeyProps) {
  return (
    <button type="button" className={cx(styles.key, className)} data-tone={tone} data-lit={lit} {...rest}>
      <span className={styles.lamp} aria-hidden="true" />
      <span className={styles.glyph} aria-hidden="true">
        {glyph}
      </span>
      <span className={cx(styles.caption, captionClassName)}>{caption}</span>
      {children}
    </button>
  );
}
