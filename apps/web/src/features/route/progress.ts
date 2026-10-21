import { clamp, EARTH_RADIUS_M, haversineM, normalizeLng, type LatLng, type RideRoute } from '@intercom/shared';
import type { RiderGap, RouteProgress } from './types';

/** Further than this from the route line counts as off route. */
export const OFF_ROUTE_M = 150;

const M_PER_DEG = (Math.PI / 180) * EARTH_RADIUS_M;

export interface PreparedRoute {
  points: LatLng[];
  /** Polyline length up to each vertex, meters. */
  cumulative: number[];
  /** Length of the (simplified) polyline, meters. */
  lengthM: number;
  /**
   * Route length for display: the router's distance when known. The polyline is simplified and a
   * little shorter, so along-route distances are scaled to this.
   */
  totalM: number;
  durationS: number;
}

export interface RouteProjection {
  /** Distance along the route to the closest point, scaled to totalM. */
  alongM: number;
  /** Great-circle distance from the point to the route, meters. */
  offRouteM: number;
  /** Closest point on the route. */
  point: LatLng;
  /** Index of the segment it lies on. */
  segment: number;
}

const validVertex = (c: readonly [number, number]) =>
  Number.isFinite(c[0]) && Number.isFinite(c[1]) && Math.abs(c[1]) <= 90 && Math.abs(c[0]) <= 180;

/** Precomputes what projections need; null for an empty route. */
export function prepareRoute(route: Pick<RideRoute, 'geometry' | 'distanceM' | 'durationS'>): PreparedRoute | null {
  const points = route.geometry.filter(validVertex).map(([lng, lat]) => ({ lat, lng }));
  if (points.length === 0) return null;
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) cumulative.push(cumulative[i - 1]! + haversineM(points[i - 1]!, points[i]!));
  const lengthM = cumulative[cumulative.length - 1]!;
  const totalM = Number.isFinite(route.distanceM) && route.distanceM > 0 ? route.distanceM : lengthM;
  const durationS = Number.isFinite(route.durationS) ? Math.max(0, route.durationS) : 0;
  return { points, cumulative, lengthM, totalM, durationS };
}

/**
 * Closest point of the route to `p`. Each segment is projected in a local equirectangular frame
 * centered on `p`, which is accurate where it matters: near the rider.
 */
export function projectOntoRoute(r: PreparedRoute, p: LatLng): RouteProjection {
  const { points, cumulative } = r;
  if (points.length === 1) {
    const only = points[0]!;
    return { alongM: 0, offRouteM: haversineM(p, only), point: only, segment: 0 };
  }
  const kx = M_PER_DEG * Math.cos((p.lat * Math.PI) / 180);
  const ky = M_PER_DEG;
  let bestD2 = Infinity;
  let bestSeg = 0;
  let bestT = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const ax = normalizeLng(a.lng - p.lng) * kx;
    const ay = (a.lat - p.lat) * ky;
    const dx = normalizeLng(b.lng - a.lng) * kx;
    const dy = (b.lat - a.lat) * ky;
    const len2 = dx * dx + dy * dy;
    // Zero-length segments (repeated vertices) just compare their endpoint.
    const t = len2 > 0 ? clamp(-(ax * dx + ay * dy) / len2, 0, 1) : 0;
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    const d2 = cx * cx + cy * cy;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestSeg = i;
      bestT = t;
    }
  }
  const a = points[bestSeg]!;
  const b = points[bestSeg + 1]!;
  const point = { lat: a.lat + (b.lat - a.lat) * bestT, lng: normalizeLng(a.lng + normalizeLng(b.lng - a.lng) * bestT) };
  const polyAlong = cumulative[bestSeg]! + (cumulative[bestSeg + 1]! - cumulative[bestSeg]!) * bestT;
  const scale = r.lengthM > 0 ? r.totalM / r.lengthM : 1;
  return { alongM: polyAlong * scale, offRouteM: haversineM(p, point), point, segment: bestSeg };
}

/** Where `p` is relative to the route. Before the start counts as 0 along; past the end as arrived. */
export function routeProgress(r: PreparedRoute, p: LatLng): RouteProgress {
  const proj = projectOntoRoute(r, p);
  const alongM = clamp(proj.alongM, 0, r.totalM);
  const remainingM = Math.max(0, r.totalM - alongM);
  const remainingS = r.totalM > 0 ? (r.durationS * remainingM) / r.totalM : 0;
  return {
    remainingM,
    remainingS,
    alongM,
    totalM: r.totalM,
    offRouteM: proj.offRouteM,
    offRoute: proj.offRouteM > OFF_ROUTE_M,
  };
}

/**
 * Gap from me to another rider: along the route when we're both on it (positive = they're ahead),
 * otherwise straight-line.
 */
export function riderGap(r: PreparedRoute | null, me: LatLng, other: LatLng): RiderGap {
  if (r && r.points.length >= 2) {
    const mine = projectOntoRoute(r, me);
    const theirs = projectOntoRoute(r, other);
    if (mine.offRouteM <= OFF_ROUTE_M && theirs.offRouteM <= OFF_ROUTE_M) {
      const diff = theirs.alongM - mine.alongM;
      return { meters: Math.abs(diff), ahead: diff > 0, alongRoute: true };
    }
  }
  return { meters: haversineM(me, other), ahead: null, alongRoute: false };
}
