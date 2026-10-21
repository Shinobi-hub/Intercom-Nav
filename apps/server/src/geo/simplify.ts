import { EARTH_RADIUS_M, type LngLatTuple } from '@intercom/shared';

const DEG = Math.PI / 180;

/**
 * Douglas-Peucker on [lng, lat] points with a tolerance in meters. Distances use one local
 * equirectangular projection, which is plenty accurate for deciding which vertices matter.
 * Iterative (explicit stack) so long, degenerate lines can't overflow the call stack.
 */
export function simplifyLine(points: readonly LngLatTuple[], toleranceM: number): LngLatTuple[] {
  const n = points.length;
  if (n <= 2) return points.slice();

  let latSum = 0;
  for (const p of points) latSum += p[1];
  const kx = Math.cos((latSum / n) * DEG) * DEG * EARTH_RADIUS_M;
  const ky = DEG * EARTH_RADIUS_M;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = points[i]![0] * kx;
    ys[i] = points[i]![1] * ky;
  }

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const tol2 = toleranceM * toleranceM;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    let maxD2 = -1;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d2 = segmentDistance2(xs[i]!, ys[i]!, xs[first]!, ys[first]!, xs[last]!, ys[last]!);
      if (d2 > maxD2) {
        maxD2 = d2;
        index = i;
      }
    }
    if (index !== -1 && maxD2 > tol2) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }

  const out: LngLatTuple[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]!);
  return out;
}

/**
 * Simplifies just enough to fit `maxPoints`: grows the tolerance until the line fits, then
 * bisects back towards the smallest tolerance that still fits, keeping as much detail as allowed.
 */
export function simplifyToMaxPoints(points: readonly LngLatTuple[], maxPoints: number): LngLatTuple[] {
  const limit = Math.max(2, Math.floor(maxPoints));
  if (points.length <= limit) return points.slice();

  let low = 0;
  let high = 1;
  let best = simplifyLine(points, high);
  while (best.length > limit) {
    low = high;
    high *= 2;
    best = simplifyLine(points, high);
    if (high > 4e7) return [points[0]!, points[points.length - 1]!];
  }
  for (let i = 0; i < 12 && high - low > 0.5; i++) {
    const mid = (low + high) / 2;
    const candidate = simplifyLine(points, mid);
    if (candidate.length <= limit) {
      high = mid;
      best = candidate;
    } else {
      low = mid;
    }
  }
  return best;
}

function segmentDistance2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const ex = px - (ax + t * dx);
  const ey = py - (ay + t * dy);
  return ex * ex + ey * ey;
}
