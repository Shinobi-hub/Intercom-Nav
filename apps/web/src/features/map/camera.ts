import type { LatLng } from '@intercom/shared';

export interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface Padding {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export function boundsOf(points: readonly LatLng[]): Bounds | null {
  if (points.length === 0) return null;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const p of points) {
    west = Math.min(west, p.lng);
    east = Math.max(east, p.lng);
    south = Math.min(south, p.lat);
    north = Math.max(north, p.lat);
  }
  return { west, south, east, north };
}

export interface RefitOptions {
  /** Refit when anyone gets this fraction of the fitted span outside the fitted bounds... */
  outsideFraction: number;
  /** ...or when the group has tightened to below this fraction of the fitted span (zoom back in). */
  shrinkFraction: number;
  /** Spans are treated as at least this many degrees (~100 m), so a bunched group ignores jitter. */
  minSpanDeg: number;
}

export const DEFAULT_REFIT: RefitOptions = { outsideFraction: 0.1, shrinkFraction: 0.6, minSpanDeg: 0.001 };

/** Whether the group's bounds moved enough since the last fit to justify moving the camera. */
export function needsRefit(fitted: Bounds | null, next: Bounds, o: RefitOptions = DEFAULT_REFIT): boolean {
  if (!fitted) return true;
  const latSpan = Math.max(o.minSpanDeg, fitted.north - fitted.south);
  const lngSpan = Math.max(o.minSpanDeg, fitted.east - fitted.west);
  const latTol = latSpan * o.outsideFraction;
  const lngTol = lngSpan * o.outsideFraction;
  if (
    next.north > fitted.north + latTol ||
    next.south < fitted.south - latTol ||
    next.east > fitted.east + lngTol ||
    next.west < fitted.west - lngTol
  ) {
    return true;
  }
  const nextLat = Math.max(o.minSpanDeg, next.north - next.south);
  const nextLng = Math.max(o.minSpanDeg, next.east - next.west);
  return nextLat < latSpan * o.shrinkFraction && nextLng < lngSpan * o.shrinkFraction;
}

/**
 * Room to leave around the group so riders don't end up under the ride screen's chrome (top bar and
 * route pill, bottom dock in portrait, side dock in landscape) or have their name labels clipped.
 */
export function groupPadding(width: number, height: number): Padding {
  const base: Padding =
    height >= width ? { top: 120, bottom: 220, left: 56, right: 56 } : { top: 88, bottom: 56, left: 140, right: 140 };
  // Never let padding take more than 60% of either dimension (small or split-screen windows).
  const sx = Math.min(1, (width * 0.6) / (base.left + base.right));
  const sy = Math.min(1, (height * 0.6) / (base.top + base.bottom));
  return { top: base.top * sy, bottom: base.bottom * sy, left: base.left * sx, right: base.right * sx };
}
