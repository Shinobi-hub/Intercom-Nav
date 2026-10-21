import { haversineM, LIMITS, type Place, type Result, type RideRoute } from '@intercom/shared';
import { Crosshair, Flag, LoaderCircle, Lock, MapPin, Search, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { formatDistance, formatDuration } from '../../core/format';
import { getServices } from '../../core/services';
import { useLocalStore, useRideStore, useSettings } from '../../core/store';
import { TID } from '../../core/testIds';
import { tapFeedback } from '../map/feedback';
import { getMapCenter } from '../map/mapCenter';
import styles from './DestinationPanel.module.css';
import { describeRouteError } from './errors';
import { usePlaceSearch, type PlaceSearch } from './usePlaceSearch';

export interface DestinationPanelProps {
  onDone: () => void;
}

const ICON = { size: 24, strokeWidth: 2.4, 'aria-hidden': true } as const;

/** Content of the Route sheet: destination search, "use map center", current route, clear (leader only). */
export function DestinationPanel({ onDone }: DestinationPanelProps) {
  const isLeader = useRideStore((s) => s.selfId !== null && s.ride?.leaderId === s.selfId);
  const route = useRideStore((s) => s.route);
  return (
    <div className={styles.panel}>{isLeader ? <LeaderView route={route} onDone={onDone} /> : <FollowerView route={route} />}</div>
  );
}

function useMounted() {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}

function LeaderView({ route, onDone }: { route: RideRoute | null; onDone: () => void }) {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const search = usePlaceSearch(query);
  const mounted = useMounted();
  const inputId = useId();

  async function run(label: string, action: () => Promise<Result>, fallback: string): Promise<boolean> {
    tapFeedback();
    setBusy(label);
    setError(null);
    let ok = false;
    try {
      const res = await action();
      ok = res.ok;
      if (!res.ok && mounted.current) setError(describeRouteError(res, fallback));
    } catch {
      if (mounted.current) setError(fallback);
    }
    if (mounted.current) setBusy(null);
    return ok;
  }

  async function pick(place: Place) {
    if (busy) return;
    const ok = await run(
      `Setting the route to ${place.name}…`,
      () => getServices().controller.setDestination(place),
      "Couldn't set the destination. Try again.",
    );
    if (ok && mounted.current) onDone();
  }

  function pinMapCenter() {
    const c = getMapCenter();
    if (!c) {
      setError("The map isn't ready yet.");
      return;
    }
    const lat = Math.round(c.lat * 1e5) / 1e5;
    const lng = Math.round(c.lng * 1e5) / 1e5;
    void pick({ name: 'Map pin', lat, lng, address: `${lat.toFixed(5)}, ${lng.toFixed(5)}` });
  }

  function clear() {
    if (busy) return;
    void run('Clearing the destination…', () => getServices().controller.clearRoute(), "Couldn't clear the destination. Try again.");
  }

  const disabled = busy !== null;
  return (
    <>
      {route && <CurrentDestination route={route} onClear={clear} clearDisabled={disabled} />}
      <label htmlFor={inputId} className={styles.label}>
        {route ? 'Change destination' : 'Where to?'}
      </label>
      <div className={styles.searchBox}>
        <Search {...ICON} className={styles.searchIcon} />
        <input
          id={inputId}
          className={styles.input}
          data-testid={TID.destSearchInput}
          type="search"
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          maxLength={LIMITS.placeQueryMax}
          placeholder="Search for a place"
          value={query}
          disabled={disabled}
          onChange={(e) => setQuery(e.target.value)}
          // "Search" on the keyboard just hides it, so the results are visible.
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        {query && !disabled && (
          <button type="button" className={styles.clearQuery} aria-label="Clear search" onClick={() => setQuery('')}>
            <X {...ICON} />
          </button>
        )}
      </div>
      <button type="button" className={styles.centerButton} data-testid={TID.destUseCenter} disabled={disabled} onClick={pinMapCenter}>
        <Crosshair {...ICON} />
        Use map center
      </button>
      {busy && (
        <p className={styles.busy} role="status">
          <LoaderCircle {...ICON} className={styles.spin} />
          {busy}
        </p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <SearchResults search={search} query={query} disabled={disabled} onPick={(p) => void pick(p)} />
    </>
  );
}

function SearchResults({
  search,
  query,
  disabled,
  onPick,
}: {
  search: PlaceSearch;
  query: string;
  disabled: boolean;
  onPick: (place: Place) => void;
}) {
  const units = useSettings((s) => s.units);
  const me = useLocalStore((s) => s.selfFix);
  if (search.status === 'idle') return null;
  if (search.status === 'short') return <p className={styles.hint}>Type at least {LIMITS.placeQueryMin} letters.</p>;
  if (search.status === 'error') {
    return (
      <p className={styles.error} role="alert">
        {search.message}
      </p>
    );
  }
  if (search.status === 'done' && search.results.length === 0) {
    return <p className={styles.hint}>No places found for “{query.trim()}”.</p>;
  }
  return (
    <div className={search.status === 'searching' ? styles.searching : undefined}>
      {search.status === 'searching' && (
        <p className={styles.hint} role="status">
          <LoaderCircle {...ICON} className={styles.spin} />
          Searching…
        </p>
      )}
      <ul className={styles.results}>
        {search.results.map((p, i) => (
          <li key={`${i}:${p.lat},${p.lng}:${p.name}`}>
            <button
              type="button"
              className={styles.result}
              data-testid={TID.destResult(i)}
              disabled={disabled}
              onClick={() => onPick(p)}
            >
              <MapPin {...ICON} className={styles.resultIcon} />
              <span className={styles.resultText}>
                <span className={styles.resultName}>{p.name}</span>
                {p.address && <span className={styles.resultAddress}>{p.address}</span>}
              </span>
              {me && <span className={styles.resultDistance}>{formatDistance(haversineM(me, p), units)}</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CurrentDestination({
  route,
  onClear,
  clearDisabled = false,
}: {
  route: RideRoute;
  onClear?: () => void;
  clearDisabled?: boolean;
}) {
  const units = useSettings((s) => s.units);
  const stops = route.waypoints.length;
  return (
    <div className={styles.current} data-testid={TID.destCurrent}>
      <span className={styles.currentIcon}>
        <Flag {...ICON} />
      </span>
      <div className={styles.currentText}>
        <span className={styles.currentLabel}>Destination</span>
        <span className={styles.currentName}>{route.destination.name}</span>
        {route.destination.address && <span className={styles.currentAddress}>{route.destination.address}</span>}
        <span className={styles.currentStats}>
          {formatDistance(route.distanceM, units)} · {formatDuration(route.durationS)}
          {stops > 0 && ` · via ${stops} ${stops === 1 ? 'stop' : 'stops'}`}
        </span>
        {route.profile === 'straight' && <span className={styles.note}>Straight line: no road route was found.</span>}
      </div>
      {onClear && (
        <button type="button" className={styles.clearButton} data-testid={TID.destClear} disabled={clearDisabled} onClick={onClear}>
          <X {...ICON} />
          Clear
        </button>
      )}
    </div>
  );
}

function FollowerView({ route }: { route: RideRoute | null }) {
  return (
    <>
      {route ? <CurrentDestination route={route} /> : <p className={styles.empty}>No destination set yet.</p>}
      <p className={styles.note}>
        <Lock {...ICON} />
        Only the ride leader can change the destination.
      </p>
    </>
  );
}
