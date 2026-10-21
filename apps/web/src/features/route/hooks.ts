import type { RideRoute, RiderId } from '@intercom/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocalStore, useRideStore } from '../../core/store';
import { prepareRoute, riderGap, routeProgress, type PreparedRoute } from './progress';
import type { RiderGap, RouteProgress } from './types';

/** Progress and gaps are recomputed at most this often (fixes arrive about once a second anyway). */
export const ROUTE_RECOMPUTE_MS = 1_000;

const prepared = new WeakMap<RideRoute, PreparedRoute | null>();

/** Prepared once per route object, shared by every hook and component. */
export function getPreparedRoute(route: RideRoute): PreparedRoute | null {
  if (!prepared.has(route)) prepared.set(route, prepareRoute(route));
  return prepared.get(route) ?? null;
}

/** `value`, updated at most once per `intervalMs` (first change immediately, the latest one after). */
export function useThrottledValue<T>(value: T, intervalMs: number): T {
  const [shown, setShown] = useState(value);
  const lastAt = useRef(0);
  useEffect(() => {
    if (Object.is(value, shown)) return;
    const wait = lastAt.current + intervalMs - Date.now();
    if (wait <= 0) {
      lastAt.current = Date.now();
      setShown(() => value);
      return;
    }
    const timer = setTimeout(() => {
      lastAt.current = Date.now();
      setShown(() => value);
    }, wait);
    return () => clearTimeout(timer);
  }, [value, shown, intervalMs]);
  return shown;
}

/** Re-renders every `intervalMs` (for clock-based text like an ETA). */
export function useTicker(intervalMs: number): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return tick;
}

/** My progress along the shared route, or null without a route or a GPS fix. */
export function useRouteProgress(): RouteProgress | null {
  const route = useRideStore((s) => s.route);
  const fix = useThrottledValue(
    useLocalStore((s) => s.selfFix),
    ROUTE_RECOMPUTE_MS,
  );
  return useMemo(() => {
    if (!route || !fix) return null;
    const r = getPreparedRoute(route);
    return r ? routeProgress(r, fix) : null;
  }, [route, fix]);
}

/** Gap between me and another rider, along the route when possible. Null without positions. */
export function useRiderGap(riderId: RiderId): RiderGap | null {
  const route = useRideStore((s) => s.route);
  const isSelf = useRideStore((s) => s.selfId === riderId);
  const other = useThrottledValue(
    useRideStore((s) => s.riders[riderId]?.location ?? null),
    ROUTE_RECOMPUTE_MS,
  );
  const me = useThrottledValue(
    useLocalStore((s) => s.selfFix),
    ROUTE_RECOMPUTE_MS,
  );
  return useMemo(() => {
    if (isSelf || !me || !other) return null;
    return riderGap(route ? getPreparedRoute(route) : null, me, other);
  }, [route, isSelf, me, other]);
}
