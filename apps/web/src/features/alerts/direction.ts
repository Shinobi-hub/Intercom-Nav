import type { LatLng, LocationFix } from '@intercom/shared';
import { bearingDeg, haversineM, normalizeDeg } from '@intercom/shared';

const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

/** 8-point compass label for a bearing in degrees. */
export function cardinal(deg: number): string {
  return CARDINALS[Math.round(normalizeDeg(deg) / 45) % 8]!;
}

export interface DirectionTo {
  distanceM: number;
  /** Compass bearing from me to the target. */
  bearingDeg: number;
  /** Where to point the arrow: relative to my direction of travel when I'm moving, else north-up. */
  arrowDeg: number;
  relativeToHeading: boolean;
}

/** Below this speed GPS headings are noise, so the arrow falls back to north-up. */
const MOVING_MPS = 1.5;

export function directionTo(from: LocationFix | null, to: LatLng | null): DirectionTo | null {
  if (!from || !to) return null;
  const bearing = bearingDeg(from, to);
  const moving = from.hdg !== null && (from.spd ?? 0) >= MOVING_MPS;
  return {
    distanceM: haversineM(from, to),
    bearingDeg: bearing,
    arrowDeg: moving ? normalizeDeg(bearing - from.hdg!) : bearing,
    relativeToHeading: moving,
  };
}
