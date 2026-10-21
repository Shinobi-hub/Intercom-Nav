import { TIMING } from '@intercom/shared';
import { Check, Coffee, Hourglass } from 'lucide-react';
import type { CSSProperties } from 'react';
import { getServices } from '../../../core/services';
import { useLocalStore } from '../../../core/store';
import { TID } from '../../../core/testIds';
import { tapFeedback } from '../../../ui/feedback';
import { Spinner } from '../../../ui/Spinner';
import { useNow } from '../../../ui/useNow';
import { usePress } from '../../../ui/usePress';
import { sendBreak, useBreakUi } from '../breakRequest';
import { DockKey } from './DockKey';
import styles from './dock.module.css';

const LONG_PRESS_MS = 600;

/** Tap asks the group for a break; long-press picks the kind (break, fuel, food, restroom). */
export function BreakButton() {
  const { status, cooldownUntil, statusUntil } = useBreakUi();
  const ticking = status === 'sending' || cooldownUntil > Date.now() || statusUntil > Date.now();
  const now = useNow(250, ticking);
  const remainingMs = Math.max(0, cooldownUntil - now);
  const seconds = Math.ceil(remainingMs / 1000);
  const shown = status === 'sending' ? 'sending' : now < statusUntil ? status : 'idle';

  const { pressing, bind } = usePress({
    holdMs: LONG_PRESS_MS,
    onPressStart: tapFeedback,
    onTap: () => void sendBreak('break'),
    onHold: () => {
      getServices().platform.haptics.vibrate(30);
      useLocalStore.getState().openSheet('break');
    },
  });

  let glyph = <Coffee />;
  let caption = 'BREAK';
  if (shown === 'sending') {
    glyph = <Spinner size={26} />;
    caption = 'SENDING';
  } else if (shown === 'sent') {
    glyph = <Check />;
    caption = 'SENT';
  } else if (shown === 'refused') {
    glyph = <Hourglass />;
    caption = `WAIT ${seconds}s`;
  } else if (remainingMs > 0) {
    glyph = <Hourglass />;
    caption = `${seconds}s`;
  }

  const label =
    remainingMs > 0
      ? `Break request sent. Next one possible in ${seconds} seconds. Hold for other stops.`
      : 'Ask the group for a break. Hold for fuel, food or restroom.';

  return (
    <DockKey
      tone="break"
      lit={shown === 'sent' || remainingMs > 0}
      glyph={glyph}
      caption={caption}
      aria-label={label}
      aria-haspopup="dialog"
      data-testid={TID.dockBreak}
      data-state={shown}
      data-cooldown-ms={remainingMs}
      data-pressing={pressing}
      {...bind}
    >
      {remainingMs > 0 && (
        <span
          className={styles.meter}
          style={{ '--left': String(remainingMs / TIMING.breakCooldownMs) } as CSSProperties}
          aria-hidden="true"
        />
      )}
    </DockKey>
  );
}
