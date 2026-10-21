import { haversineM, LIMITS, type LatLng, type LngLatTuple, type RideRoute } from '@intercom/shared';
import type { RoutingProviderName } from '../../config';
import type { Clock } from '../../util/clock';
import { LruCache } from '../../util/lruCache';
import { ProviderError } from '../fetchJson';
import { simplifyToMaxPoints } from '../simplify';
import { straightPath } from './straight';
import type { RoutedPath, RoutingProvider } from './types';

export interface PlannedRoute {
  geometry: LngLatTuple[];
  distanceM: number;
  durationS: number;
  provider: RideRoute['provider'];
  profile: RideRoute['profile'];
}

export interface RoutePlanner {
  readonly providerName: RoutingProviderName;
  /** Never rejects: when the provider fails the result is a straight line ('straight'). */
  plan(points: readonly LatLng[]): Promise<PlannedRoute>;
}

export interface RoutePlannerOptions {
  provider: RoutingProvider;
  now: Clock;
  /** Called with the provider's error before falling back to a straight line. */
  onProviderError?: (err: unknown) => void;
  cacheTtlMs?: number;
  cacheSize?: number;
  maxPoints?: number;
}

const CACHE_TTL_MS = 10 * 60_000;
/** ~11 m: requests this close together share a cached route. */
const CACHE_KEY_DECIMALS = 4;
/** ~0.1 m: more digits only bloat the payload. */
const COORD_DECIMALS = 6;
/**
 * Routers snap the ends to the nearest road. When that road is further than this, the "route"
 * describes some other place (OSRM happily snaps mid-ocean points to an island 800 km away).
 */
const MAX_ENDPOINT_GAP_M = 5_000;

export function createRoutePlanner(opts: RoutePlannerOptions): RoutePlanner {
  const cache = new LruCache<PlannedRoute>({
    maxEntries: opts.cacheSize ?? 200,
    ttlMs: opts.cacheTtlMs ?? CACHE_TTL_MS,
    now: opts.now,
  });
  const maxPoints = opts.maxPoints ?? LIMITS.maxRoutePoints;

  const finish = (path: RoutedPath, provider: PlannedRoute['provider'], profile: PlannedRoute['profile']) => ({
    geometry: simplifyToMaxPoints(tidy(path.geometry), maxPoints),
    distanceM: path.distanceM,
    durationS: path.durationS,
    provider,
    profile,
  });

  return {
    providerName: opts.provider.name,
    async plan(points) {
      const key = points.map((p) => `${p.lat.toFixed(CACHE_KEY_DECIMALS)},${p.lng.toFixed(CACHE_KEY_DECIMALS)}`).join(';');
      const cached = cache.get(key);
      if (cached) return cached;
      try {
        const path = await opts.provider.route(points);
        assertUsable(path, points);
        const planned = finish(path, opts.provider.name, opts.provider.profile);
        cache.set(key, planned);
        return planned;
      } catch (err) {
        // Not cached: the provider may well be back for the next request.
        opts.onProviderError?.(err);
        return finish(straightPath(points), 'straight', 'straight');
      }
    },
  };
}

function assertUsable(path: RoutedPath, points: readonly LatLng[]): void {
  const okNumber = (n: number) => Number.isFinite(n) && n >= 0;
  if (!okNumber(path.distanceM) || !okNumber(path.durationS)) throw new ProviderError('invalid route summary');
  if (path.geometry.length < 2) throw new ProviderError('route has no geometry');
  for (const [lng, lat] of path.geometry) {
    if (!(Math.abs(lng) <= 180 && Math.abs(lat) <= 90)) throw new ProviderError('route has invalid coordinates');
  }
  const gap = (p: LngLatTuple, q: LatLng) => haversineM({ lng: p[0], lat: p[1] }, q);
  if (
    gap(path.geometry[0]!, points[0]!) > MAX_ENDPOINT_GAP_M ||
    gap(path.geometry[path.geometry.length - 1]!, points[points.length - 1]!) > MAX_ENDPOINT_GAP_M
  ) {
    throw new ProviderError('route does not reach the requested points');
  }
}

/** Rounds coordinates and drops consecutive duplicates, keeping at least two points. */
function tidy(geometry: readonly LngLatTuple[]): LngLatTuple[] {
  const f = 10 ** COORD_DECIMALS;
  const out: LngLatTuple[] = [];
  for (const [lng, lat] of geometry) {
    const p: LngLatTuple = [Math.round(lng * f) / f, Math.round(lat * f) / f];
    const prev = out[out.length - 1];
    if (!prev || prev[0] !== p[0] || prev[1] !== p[1]) out.push(p);
  }
  if (out.length === 1) out.push([out[0]![0], out[0]![1]]);
  return out;
}
