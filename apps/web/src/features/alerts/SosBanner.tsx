import { Bike, LocateFixed, Navigation, Siren } from 'lucide-react';
import { formatDistance } from '../../core/format';
import type { TrackedSos } from '../../core/store';
import { useLocalStore, useRideStore, useSettings } from '../../core/store';
import { TID } from '../../core/testIds';
import { Button } from '../../ui/Button';
import { cx } from '../../ui/cx';
import { openDirections, respondToSos, showRiderOnMap } from './actions';
import { cardinal, directionTo } from './direction';
import { useSilencedSos, useSosLocation } from './sos';
import styles from './SosBanners.module.css';

/** Compact, persistent reminder of SOS alerts this device silenced. Stays until the raiser cancels. */
export function SosBanner() {
  const silenced = useSilencedSos();
  return (
    <>
      {silenced.map((sos) => (
        <SilencedSos key={sos.id} sos={sos} />
      ))}
    </>
  );
}

function SilencedSos({ sos }: { sos: TrackedSos }) {
  const rider = useRideStore((s) => s.riders[sos.riderId]);
  const selfId = useRideStore((s) => s.selfId);
  const selfFix = useLocalStore((s) => s.selfFix);
  const units = useSettings((s) => s.units);
  const target = useSosLocation(sos);
  const direction = directionTo(selfFix, target);
  const responding = sos.responders.some((r) => r.riderId === selfId);
  const name = rider?.name ?? 'A rider';

  return (
    <section className={styles.banner} data-testid={TID.sosBanner} data-sos-id={sos.id} aria-label={`SOS from ${name}`}>
      <div className={styles.line}>
        <Siren className={styles.icon} aria-hidden="true" />
        <span className={styles.title}>
          SOS <span className={styles.sep}>·</span> {name}
        </span>
        {direction && (
          <span className={styles.distance}>
            {formatDistance(direction.distanceM, units)} {cardinal(direction.bearingDeg)}
          </span>
        )}
      </div>
      {responding && <p className={styles.note}>You're on the way. {name} has been told.</p>}
      <div className={styles.actions}>
        {!responding && (
          <Button variant="light" icon={Bike} className={styles.action} onClick={() => respondToSos(sos.id)}>
            I'm coming
          </Button>
        )}
        <Button
          variant="outline"
          icon={Navigation}
          className={cx(styles.action, styles.plate)}
          disabled={!target}
          onClick={() => target && openDirections(target)}
        >
          Navigate
        </Button>
        <Button
          variant="outline"
          icon={LocateFixed}
          className={cx(styles.action, styles.plate)}
          onClick={() => showRiderOnMap(sos.riderId)}
        >
          Show on map
        </Button>
      </div>
    </section>
  );
}
