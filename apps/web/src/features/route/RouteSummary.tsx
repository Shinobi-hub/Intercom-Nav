import { haversineM } from '@intercom/shared';
import { Flag, TriangleAlert } from 'lucide-react';
import { formatDistance, formatDuration, formatEta } from '../../core/format';
import { useLocalStore, useRideStore, useSettings } from '../../core/store';
import { TID } from '../../core/testIds';
import { tapFeedback } from '../map/feedback';
import { ROUTE_RECOMPUTE_MS, useRouteProgress, useThrottledValue, useTicker } from './hooks';
import styles from './RouteSummary.module.css';

const ICON = { size: 24, strokeWidth: 2.6, 'aria-hidden': true } as const;
/** Keeps the ETA's clock time right while no fixes arrive (stopped, GPS off). */
const ETA_REFRESH_MS = 30_000;

function openRouteSheet(): void {
  tapFeedback();
  useLocalStore.getState().openSheet('route');
}

/** Compact pill: "Lonavala · 42 km · 38 min · ETA 14:35". Renders nothing without a route. */
export function RouteSummary() {
  const route = useRideStore((s) => s.route);
  const progress = useRouteProgress();
  const units = useSettings((s) => s.units);
  const me = useThrottledValue(
    useLocalStore((s) => s.selfFix),
    ROUTE_RECOMPUTE_MS,
  );
  useTicker(ETA_REFRESH_MS);
  if (!route) return null;

  const name = route.destination.name;
  if (progress?.offRoute) {
    const straight = formatDistance(me ? haversineM(me, route.destination) : progress.offRouteM, units);
    return (
      <button
        type="button"
        className={`${styles.pill} ${styles.offRoute}`}
        data-testid={TID.routeSummary}
        data-off-route="true"
        aria-label={`Off route. ${name} is ${straight} away in a straight line. Open route.`}
        onClick={openRouteSheet}
      >
        <span className={styles.icon}>
          <TriangleAlert {...ICON} />
        </span>
        <span className={styles.text}>
          <span className={styles.title}>Off route</span>
          <span className={styles.sep}> · </span>
          <span className={styles.stats}>{straight} straight</span>
        </span>
      </button>
    );
  }

  const remainingM = progress?.remainingM ?? route.distanceM;
  const remainingS = progress?.remainingS ?? route.durationS;
  const distance = formatDistance(remainingM, units);
  const duration = formatDuration(remainingS);
  const eta = formatEta(remainingS);
  return (
    <button
      type="button"
      className={styles.pill}
      data-testid={TID.routeSummary}
      data-off-route="false"
      aria-label={`Route to ${name}: ${distance}, ${duration}, arriving at ${eta}. Open route.`}
      onClick={openRouteSheet}
    >
      <span className={styles.icon}>
        <Flag {...ICON} />
      </span>
      <span className={styles.text}>
        <span className={styles.title}>{name}</span>
        <span className={styles.sep}> · </span>
        <span className={styles.stats}>
          {distance}
          <span className={styles.dot}> · </span>
          {duration}
          <span className={styles.dot}> · </span>
          ETA {eta}
        </span>
      </span>
    </button>
  );
}
