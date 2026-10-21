// @vitest-environment node
import { destinationPoint, EARTH_RADIUS_M, haversineM, type LatLng } from '@intercom/shared';
import { describe, expect, it } from 'vitest';
import { OFF_ROUTE_M, prepareRoute, projectOntoRoute, riderGap, routeProgress, type PreparedRoute } from './progress';

const A = { lat: 18.52, lng: 73.85 };
const M_PER_DEG_LAT = (Math.PI / 180) * EARTH_RADIUS_M;
const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos((A.lat * Math.PI) / 180);

/**
 * `metersEast` east of A along A's parallel, then `metersNorth` north. Route segments are straight
 * in lat/lng, so points built this way lie exactly on (or squarely off) an east-west segment.
 */
const at = (metersEast: number, metersNorth = 0) => ({
  lat: A.lat + metersNorth / M_PER_DEG_LAT,
  lng: A.lng + metersEast / M_PER_DEG_LNG,
});
/** 10 km east of A. */
const B = at(10_000);
const lngLat = (p: LatLng): [number, number] => [p.lng, p.lat];

function route(points: LatLng[], distanceM = 0, durationS = 600): PreparedRoute {
  return prepareRoute({ geometry: points.map(lngLat), distanceM, durationS })!;
}

describe('prepareRoute', () => {
  it('returns null for an empty route and drops invalid vertices', () => {
    expect(prepareRoute({ geometry: [], distanceM: 0, durationS: 0 })).toBeNull();
    const r = prepareRoute({ geometry: [[Number.NaN, 1], lngLat(A), [200, 0], lngLat(B)], distanceM: 0, durationS: 0 })!;
    expect(r.points).toHaveLength(2);
    expect(r.lengthM).toBeCloseTo(10_000, 0);
  });

  it("uses the router's distance as the total when it has one", () => {
    expect(route([A, B], 11_000).totalM).toBe(11_000);
    expect(route([A, B], 0).totalM).toBeCloseTo(10_000, 0);
  });
});

describe('routeProgress', () => {
  it('measures along, remaining and time on the route', () => {
    const p = routeProgress(route([A, B]), at(3_000));
    expect(p.alongM).toBeCloseTo(3_000, 0);
    expect(p.remainingM).toBeCloseTo(7_000, 0);
    expect(p.totalM).toBeCloseTo(10_000, 0);
    expect(p.remainingS).toBeCloseTo(420, 0);
    expect(p.offRouteM).toBeLessThan(0.5);
    expect(p.offRoute).toBe(false);
  });

  it(`flags more than ${OFF_ROUTE_M} m from the line as off route`, () => {
    const near = routeProgress(route([A, B]), at(3_000, 120));
    expect(near.offRouteM).toBeCloseTo(120, 0);
    expect(near.offRoute).toBe(false);
    expect(near.alongM).toBeCloseTo(3_000, 0);
    const far = routeProgress(route([A, B]), at(3_000, -400));
    expect(far.offRouteM).toBeCloseTo(400, 0);
    expect(far.offRoute).toBe(true);
  });

  it("scales along-route distances to the router's total", () => {
    const p = routeProgress(route([A, B], 11_000, 660), at(5_000));
    expect(p.alongM).toBeCloseTo(5_500, 0);
    expect(p.remainingM).toBeCloseTo(5_500, 0);
    expect(p.remainingS).toBeCloseTo(330, 0);
  });

  it('treats a rider before the start as 0 along, with the distance to the start as off-route', () => {
    const p = routeProgress(route([A, B]), at(-500));
    expect(p.alongM).toBe(0);
    expect(p.remainingM).toBeCloseTo(10_000, 0);
    expect(p.offRouteM).toBeCloseTo(500, 0);
    expect(p.offRoute).toBe(true);
  });

  it('treats a rider past the end as arrived', () => {
    const p = routeProgress(route([A, B]), at(10_080));
    expect(p.remainingM).toBe(0);
    expect(p.remainingS).toBe(0);
    expect(p.alongM).toBeCloseTo(10_000, 0);
    expect(p.offRouteM).toBeCloseTo(80, 0);
    expect(p.offRoute).toBe(false);
  });

  it('follows multi-segment routes and picks the nearest segment', () => {
    const corner = B;
    const C = destinationPoint(B, 0, 4_000);
    const r = route([A, corner, C]);
    const p = routeProgress(r, destinationPoint(corner, 0, 1_000));
    expect(p.alongM).toBeCloseTo(11_000, 0);
    expect(p.remainingM).toBeCloseTo(3_000, 0);
    expect(projectOntoRoute(r, destinationPoint(corner, 0, 1_000)).segment).toBe(1);
  });

  it('ignores zero-length segments from repeated vertices', () => {
    const p = routeProgress(route([A, A, at(5_000), at(5_000), B, B]), at(7_000, 30));
    expect(p.alongM).toBeCloseTo(7_000, 0);
    expect(p.offRouteM).toBeCloseTo(30, 0);
  });

  it('handles a single-point route', () => {
    const r = route([B]);
    const p = routeProgress(r, at(9_000));
    expect(p).toMatchObject({ alongM: 0, remainingM: 0, remainingS: 0, totalM: 0, offRoute: true });
    expect(p.offRouteM).toBeCloseTo(1_000, 0);
  });

  it('handles a route whose points are all identical', () => {
    const p = routeProgress(route([A, A], 0, 0), at(50));
    expect(p).toMatchObject({ alongM: 0, remainingM: 0, remainingS: 0, offRoute: false });
    expect(p.offRouteM).toBeCloseTo(50, 0);
  });

  it('works across the antimeridian', () => {
    const W = { lat: 0, lng: 179.99 };
    const E = { lat: 0, lng: -179.99 };
    const r = route([W, E]);
    expect(r.lengthM).toBeCloseTo(haversineM(W, E), 0);
    const p = routeProgress(r, { lat: 0.0001, lng: 180 });
    expect(p.alongM).toBeCloseTo(r.lengthM / 2, -1);
    expect(p.offRouteM).toBeCloseTo(11, 0);
  });
});

describe('riderGap', () => {
  const r = route([A, B]);

  it('is the difference along the route when both riders are on it', () => {
    expect(riderGap(r, at(2_000), at(3_500, 40))).toMatchObject({ ahead: true, alongRoute: true });
    expect(riderGap(r, at(2_000), at(3_500, 40)).meters).toBeCloseTo(1_500, 0);
    const behind = riderGap(r, at(6_000), at(1_000));
    expect(behind.ahead).toBe(false);
    expect(behind.meters).toBeCloseTo(5_000, 0);
  });

  it('measures along a winding route, not as the crow flies', () => {
    const hairpin = route([A, B, destinationPoint(B, 0, 1_000), destinationPoint(A, 0, 1_000)]);
    const me = at(5_000);
    const other = destinationPoint(at(5_000), 0, 1_000);
    const gap = riderGap(hairpin, me, other);
    expect(gap.alongRoute).toBe(true);
    expect(gap.meters).toBeCloseTo(5_000 + 1_000 + 5_000, -1);
  });

  it('falls back to straight-line distance when someone is off route', () => {
    const me = at(2_000);
    const other = at(3_000, 500);
    expect(riderGap(r, me, other)).toEqual({ meters: haversineM(me, other), ahead: null, alongRoute: false });
    expect(riderGap(r, other, me).alongRoute).toBe(false);
  });

  it('uses straight-line distance without a usable route', () => {
    const me = at(0);
    const other = at(800);
    expect(riderGap(null, me, other)).toEqual({ meters: haversineM(me, other), ahead: null, alongRoute: false });
    expect(riderGap(route([B]), me, other).alongRoute).toBe(false);
  });
});
