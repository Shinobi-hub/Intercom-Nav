import { bearingDeg, destinationPoint, haversineM, polylineLengthM, type LatLng, type LngLatTuple } from '@intercom/shared';
import { FALLBACK_SPEED_MPS, type RoutedPath, type RoutingProvider } from './types';

const STEP_M = 100;
const WIGGLE_M = 12;

/**
 * Deterministic, offline "road": every leg is densified to ~100 m steps with a small sideways
 * wiggle, so it looks and projects like a real route while staying predictable for tests.
 * The given points themselves are kept exactly.
 */
export function mockRoutePath(points: readonly LatLng[]): RoutedPath {
  const geometry: LngLatTuple[] = [];
  for (let leg = 0; leg < points.length - 1; leg++) {
    const a = points[leg]!;
    const b = points[leg + 1]!;
    const steps = Math.max(1, Math.ceil(haversineM(a, b) / STEP_M));
    const bearing = bearingDeg(a, b);
    for (let i = leg === 0 ? 0 : 1; i <= steps; i++) {
      let p: LatLng;
      if (i === 0) p = a;
      else if (i === steps) p = b;
      else {
        const t = i / steps;
        const base = { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
        // The envelope fades the wiggle out towards both ends of the leg.
        p = destinationPoint(base, bearing + 90, WIGGLE_M * Math.sin(Math.PI * t) * Math.sin(i * 0.9));
      }
      geometry.push([p.lng, p.lat]);
    }
  }
  const distanceM = polylineLengthM(geometry);
  return { geometry, distanceM, durationS: distanceM / FALLBACK_SPEED_MPS };
}

export function createMockRoutingProvider(): RoutingProvider {
  return {
    name: 'mock',
    profile: 'motorcycle',
    route: async (points) => mockRoutePath(points),
  };
}
