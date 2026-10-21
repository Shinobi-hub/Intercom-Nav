import { TIMING } from '@intercom/shared';
import { Siren, X } from 'lucide-react';
import { getServices } from '../../core/services';
import { useRideStore } from '../../core/store';
import { TID } from '../../core/testIds';
import { cx } from '../../ui/cx';
import { HoldButton } from '../../ui/HoldButton';
import { useOwnSos } from './sos';
import styles from './SosBanners.module.css';

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** While my own SOS is active: delivery state, who is coming, and hold-to-cancel. */
export function SosActiveBanner() {
  const own = useOwnSos();
  const riders = useRideStore((s) => s.riders);
  if (!own) return null;

  const names = own.responders.map((r) => riders[r.riderId]?.name ?? 'A rider');
  const delivered = own.source !== 'local';

  return (
    <section
      className={cx(styles.banner, styles.own)}
      data-testid={TID.sosActiveBanner}
      data-source={own.source}
      aria-label="Your SOS is active"
    >
      <div className={styles.line}>
        <Siren className={cx(styles.icon, styles.beacon, 'allow-motion')} aria-hidden="true" />
        <span className={styles.title}>SOS ACTIVE</span>
        <span className={styles.status} data-delivered={delivered}>
          {delivered ? 'Group alerted' : 'Sending…'}
        </span>
      </div>
      <p className={styles.responders} data-testid={TID.sosResponders} data-count={names.length} aria-live="polite">
        {names.length > 0
          ? `${joinNames(names)} ${names.length === 1 ? 'is' : 'are'} coming`
          : 'Waiting for riders to respond'}
      </p>
      <HoldButton
        label="Hold to cancel SOS"
        holdingLabel="Keep holding to cancel"
        icon={X}
        durationMs={TIMING.sosHoldMs}
        testId={TID.sosCancel}
        className={styles.cancel}
        onConfirm={() => void getServices().controller.cancelSos(own.id)}
      />
    </section>
  );
}
