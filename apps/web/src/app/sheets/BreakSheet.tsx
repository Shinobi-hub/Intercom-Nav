import type { BreakKind } from '@intercom/shared';
import { TIMING } from '@intercom/shared';
import type { LucideIcon } from 'lucide-react';
import { Coffee, Fuel, Toilet, Utensils } from 'lucide-react';
import { TID } from '../../core/testIds';
import { tapFeedback } from '../../ui/feedback';
import { sendBreak } from '../ride/breakRequest';
import styles from './sheets.module.css';

const KINDS: ReadonlyArray<{ kind: BreakKind; label: string; icon: LucideIcon }> = [
  { kind: 'break', label: 'Break', icon: Coffee },
  { kind: 'fuel', label: 'Fuel', icon: Fuel },
  { kind: 'food', label: 'Food', icon: Utensils },
  { kind: 'restroom', label: 'Restroom', icon: Toilet },
];

/** Kind picker behind a long-press on the Break key. */
export function BreakSheet({ onDone }: { onDone: () => void }) {
  return (
    <div className={styles.stackLg}>
      <div className={styles.kinds}>
        {KINDS.map(({ kind, label, icon: Icon }) => (
          <button
            key={kind}
            type="button"
            className={styles.kind}
            data-testid={TID.breakKind(kind)}
            onClick={() => {
              tapFeedback();
              onDone();
              void sendBreak(kind);
            }}
          >
            <Icon className={styles.kindIcon} aria-hidden="true" />
            <span>{label}</span>
          </button>
        ))}
      </div>
      <p className={styles.note}>
        Everyone hears a chime and sees who asked. One request every {TIMING.breakCooldownMs / 1000} seconds.
      </p>
    </div>
  );
}
