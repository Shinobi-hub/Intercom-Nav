import { ArrowUp, BellOff, Bike, Navigation, Siren } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { formatAgo, formatDistance } from '../../core/format';
import type { TrackedSos } from '../../core/store';
import { useLocalStore, useRideStore, useSettings } from '../../core/store';
import { TID } from '../../core/testIds';
import { Button } from '../../ui/Button';
import { cx } from '../../ui/cx';
import { RiderAvatar } from '../../ui/RiderAvatar';
import { useNow } from '../../ui/useNow';
import { openDirections, respondToSos, silenceSos } from './actions';
import { cardinal, directionTo } from './direction';
import { useIncomingSos, useSosLocation } from './sos';
import styles from './SosOverlay.module.css';

/**
 * Full-screen alarm for another rider's SOS that this device hasn't silenced. Flashes red/black at
 * 2 Hz (under the 3 Hz photosensitivity limit); with reduced motion it pulses slowly instead.
 */
export function SosOverlay() {
  const incoming = useIncomingSos();
  const sos = incoming[0];
  if (!sos) return null;
  return <SosAlarm key={sos.id} sos={sos} waiting={incoming.length - 1} />;
}

function SosAlarm({ sos, waiting }: { sos: TrackedSos; waiting: number }) {
  const titleId = useId();
  const rider = useRideStore((s) => s.riders[sos.riderId]);
  const selfId = useRideStore((s) => s.selfId);
  const riders = useRideStore((s) => s.riders);
  const clockOffsetMs = useRideStore((s) => s.clockOffsetMs);
  const selfFix = useLocalStore((s) => s.selfFix);
  const units = useSettings((s) => s.units);
  const target = useSosLocation(sos);
  const now = useNow(1_000);
  const respondRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    respondRef.current?.focus({ preventScroll: true });
  }, []);

  const name = rider?.name ?? 'A rider';
  const direction = directionTo(selfFix, target);
  const responders = sos.responders.filter((r) => r.riderId !== selfId).map((r) => riders[r.riderId]?.name ?? 'A rider');

  return createPortal(
    <div
      className={cx(styles.overlay, 'allow-motion')}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-testid={TID.sosOverlay}
      data-sos-id={sos.id}
      data-rider-id={sos.riderId}
    >
      <div className={styles.flash} aria-hidden="true" />
      <div className={styles.content}>
        <div className={styles.info}>
          <div className={styles.mark}>
            <Siren className={styles.markIcon} aria-hidden="true" />
            <span>SOS</span>
          </div>
          <h2 id={titleId} className={styles.who}>
            <RiderAvatar name={name} color={rider?.color ?? '#ffffff'} size="md" />
            <span className={styles.name}>{name}</span>
          </h2>
          <p className={styles.needs}>needs help</p>
          {direction ? (
            <div className={styles.where} aria-label={`${formatDistance(direction.distanceM, units)} ${cardinal(direction.bearingDeg)}`}>
              <ArrowUp
                className={styles.arrow}
                style={{ transform: `rotate(${direction.arrowDeg}deg)` }}
                aria-hidden="true"
              />
              <span className={styles.distance}>{formatDistance(direction.distanceM, units)}</span>
              <span className={styles.bearing}>{cardinal(direction.bearingDeg)}</span>
            </div>
          ) : (
            <p className={styles.unknown}>{target ? 'Waiting for your GPS' : 'Location unknown'}</p>
          )}
          <p className={styles.meta}>
            Raised {formatAgo(now + clockOffsetMs - sos.raisedAt)}
            {responders.length > 0 && ` · ${responders.join(', ')} ${responders.length === 1 ? 'is' : 'are'} coming`}
          </p>
        </div>
        <div className={styles.actions}>
          <Button
            ref={respondRef}
            variant="light"
            size="lg"
            block
            icon={Bike}
            className={styles.respond}
            data-testid={TID.sosRespond}
            onClick={() => respondToSos(sos.id)}
          >
            I'M COMING
          </Button>
          <Button
            variant="outline"
            size="lg"
            block
            icon={Navigation}
            className={styles.secondary}
            disabled={!target}
            data-testid={TID.sosNavigate}
            onClick={() => {
              if (!target) return;
              // Heading to the maps app: silence first so the siren doesn't follow into the background.
              silenceSos(sos.id);
              openDirections(target);
            }}
          >
            NAVIGATE
          </Button>
          <Button
            variant="outline"
            size="md"
            block
            icon={BellOff}
            className={styles.secondary}
            data-testid={TID.sosSilence}
            onClick={() => silenceSos(sos.id)}
          >
            SILENCE
          </Button>
          {waiting > 0 && (
            <p className={styles.waiting}>
              {waiting} more SOS {waiting === 1 ? 'alert' : 'alerts'} after this one
            </p>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
