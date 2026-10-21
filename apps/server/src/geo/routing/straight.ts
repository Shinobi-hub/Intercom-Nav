import { polylineLengthM, type LatLng, type LngLatTuple } from '@intercom/shared';
import { FALLBACK_SPEED_MPS, type RoutedPath } from './types';

/** Last resort when routing fails: straight segments through the given points. */
export function straightPath(points: readonly LatLng[]): RoutedPath {
  const geometry = points.map((p): LngLatTuple => [p.lng, p.lat]);
  const distanceM = polylineLengthM(geometry);
  return { geometry, distanceM, durationS: distanceM / FALLBACK_SPEED_MPS };
}
