// Helpers for unit tests and simulations (deterministic noise, synthetic fixes). Not used by the app.
import { destinationPoint, type LatLng } from '@intercom/shared';
import type { RawFix } from '../../core/services';

/** Deterministic PRNG (mulberry32) returning floats in [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Standard normal samples (Box-Muller) from a uniform source. */
export function gaussian(random: () => number): () => number {
  return () => {
    const u = Math.max(random(), 1e-12);
    const v = random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

/** Moves `p` by a random offset with the given 1-sigma error per axis, meters. */
export function jitter(p: LatLng, sigmaM: number, normal: () => number): LatLng {
  const north = destinationPoint(p, 0, normal() * sigmaM);
  return destinationPoint(north, 90, normal() * sigmaM);
}

export function rawFix(p: Partial<RawFix> & LatLng & { timestamp: number }): RawFix {
  return { accuracy: 5, speed: null, heading: null, altitude: null, ...p };
}
