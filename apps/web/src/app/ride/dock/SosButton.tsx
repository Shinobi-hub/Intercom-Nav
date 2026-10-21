import { TIMING } from '@intercom/shared';
import { Siren } from 'lucide-react';
import { getServices } from '../../../core/services';
import { TID } from '../../../core/testIds';
import { useOwnSos } from '../../../features/alerts';
import { tapFeedback, tickFeedback } from '../../../ui/feedback';
import { HoldRing } from '../../../ui/HoldRing';
import { usePress } from '../../../ui/usePress';
import { DockKey } from './DockKey';
import styles from './dock.module.css';

/** Hold for TIMING.sosHoldMs to raise an SOS. Releasing or sliding off early cancels. */
export function SosButton() {
  const active = useOwnSos() !== null;
  const { pressing, bind } = usePress({
    holdMs: TIMING.sosHoldMs,
    disabled: active,
    onPressStart: tapFeedback,
    onTick: tickFeedback,
    onHold: () => void getServices().controller.raiseSos(),
  });

  const seconds = (TIMING.sosHoldMs / 1000).toFixed(1);
  return (
    <DockKey
      tone="sos"
      lit={active || pressing}
      className={styles.sos}
      glyph={
        <>
          <HoldRing active={pressing} durationMs={TIMING.sosHoldMs} size={56} className={styles.ring} />
          <Siren />
        </>
      }
      caption={active ? 'SOS ACTIVE' : pressing ? 'HOLD' : 'SOS'}
      aria-label={
        active
          ? 'SOS active. To call it off, hold Cancel on the SOS banner.'
          : `SOS. Press and hold for ${seconds} seconds to alert the group.`
      }
      aria-disabled={active || undefined}
      data-testid={TID.dockSos}
      data-active={active}
      data-holding={pressing}
      {...bind}
    />
  );
}
