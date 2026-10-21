import type { LatLng, LngLatTuple } from '@intercom/shared';
import type { RoutingProviderName } from '../../config';

/** A provider's answer, before simplification. */
export interface RoutedPath {
  geometry: LngLatTuple[];
  distanceM: number;
  durationS: number;
}

export interface RoutingProvider {
  readonly name: RoutingProviderName;
  readonly profile: 'motorcycle' | 'car';
  /** `points` = origin, waypoints..., destination (at least two). Rejects when no route is found. */
  route(points: readonly LatLng[]): Promise<RoutedPath>;
}

/** Average speed assumed when we have to estimate durations ourselves (≈ 60 km/h). */
export const FALLBACK_SPEED_MPS = 16.7;
