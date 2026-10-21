// @vitest-environment node
import { bearingDeg, destinationPoint, haversineM } from '@intercom/shared';
import { describe, expect, it } from 'vitest';
import { PositionKalman } from './kalman';
import { gaussian, jitter, seededRandom } from './testing';

const HOME = { lat: 18.52, lng: 73.85 };
const T0 = 1_700_000_000_000;

function rms(values: number[]): number {
  return Math.sqrt(values.reduce((s, v) => s + v * v, 0) / values.length);
}

/** Signed along-track error of `est` relative to `truth` for travel on `bearing` (negative = behind). */
function alongTrackError(est: { lat: number; lng: number }, truth: { lat: number; lng: number }, bearing: number): number {
  const d = haversineM(truth, est);
  if (d < 1e-6) return 0;
  const rel = ((bearingDeg(truth, est) - bearing) * Math.PI) / 180;
  return d * Math.cos(rel);
}

describe('PositionKalman', () => {
  it('starts at the first measurement with its accuracy as uncertainty', () => {
    const k = new PositionKalman();
    expect(k.estimate).toBeNull();
    const e = k.update({ ...HOME, accuracyM: 12, t: T0, speedMps: null });
    expect(e).toEqual({ lat: HOME.lat, lng: HOME.lng, sigmaM: 12, t: T0 });
  });

  it('averages out jitter while standing still', () => {
    const normal = gaussian(seededRandom(1));
    const k = new PositionKalman();
    const rawErr: number[] = [];
    const estErr: number[] = [];
    for (let i = 0; i < 120; i++) {
      const m = jitter(HOME, 4, normal);
      const e = k.update({ ...m, accuracyM: 5, t: T0 + i * 1000, speedMps: 0 });
      if (i >= 10) {
        rawErr.push(haversineM(HOME, m));
        estErr.push(haversineM(HOME, e));
      }
    }
    expect(rms(estErr)).toBeLessThan(rms(rawErr) * 0.5);
  });

  it('does not lag behind a rider at highway speed', () => {
    const normal = gaussian(seededRandom(2));
    const k = new PositionKalman();
    const speed = 33; // ~120 km/h
    const bearing = 60;
    const errors: number[] = [];
    let worst = 0;
    for (let i = 0; i < 90; i++) {
      const truth = destinationPoint(HOME, bearing, speed * i);
      const m = jitter(truth, 4, normal);
      const e = k.update({ ...m, accuracyM: 6, t: T0 + i * 1000, speedMps: speed });
      if (i >= 5) {
        errors.push(alongTrackError(e, truth, bearing));
        worst = Math.max(worst, haversineM(e, truth));
      }
    }
    const meanAlong = errors.reduce((s, v) => s + v, 0) / errors.length;
    expect(Math.abs(meanAlong)).toBeLessThan(2);
    expect(worst).toBeLessThan(20);
  });

  it('keeps up when the speed comes from consecutive fixes rather than the provider', () => {
    const k = new PositionKalman();
    const speed = 30;
    let lagSum = 0;
    let n = 0;
    let prev = HOME;
    for (let i = 0; i < 30; i++) {
      const truth = destinationPoint(HOME, 0, speed * i);
      const derived = i === 0 ? null : haversineM(prev, truth);
      prev = truth;
      const e = k.update({ ...truth, accuracyM: 10, t: T0 + i * 1000, speedMps: derived });
      if (i >= 5) {
        lagSum += -alongTrackError(e, truth, 0);
        n++;
      }
    }
    expect(lagSum / n).toBeLessThan(4);
  });

  it('would trail far behind without speed scaling (why the process noise follows speed)', () => {
    const k = new PositionKalman();
    let truth = HOME;
    for (let i = 0; i < 30; i++) {
      truth = destinationPoint(HOME, 0, 30 * i);
      k.update({ ...truth, accuracyM: 10, t: T0 + i * 1000, speedMps: 0 });
    }
    expect(haversineM(k.estimate!, truth)).toBeGreaterThan(50);
  });

  it('trusts accurate fixes more than inaccurate ones', () => {
    const target = destinationPoint(HOME, 90, 40);
    const moveWith = (accuracyM: number) => {
      const k = new PositionKalman();
      k.update({ ...HOME, accuracyM: 5, t: T0, speedMps: 0 });
      return haversineM(HOME, k.update({ ...target, accuracyM, t: T0 + 1000, speedMps: 0 }));
    };
    expect(moveWith(3)).toBeGreaterThan(moveWith(30) * 3);
  });

  it('follows the new fix after a long gap', () => {
    const k = new PositionKalman();
    k.update({ ...HOME, accuracyM: 5, t: T0, speedMps: 0 });
    const far = destinationPoint(HOME, 180, 2_000);
    const e = k.update({ ...far, accuracyM: 8, t: T0 + 10 * 60_000, speedMps: null });
    expect(haversineM(e, far)).toBeLessThan(1);
  });

  it('treats a 0 m accuracy as 1 m instead of freezing on it', () => {
    const k = new PositionKalman();
    k.update({ ...HOME, accuracyM: 0, t: T0, speedMps: 0 });
    const e = k.update({ ...destinationPoint(HOME, 0, 10), accuracyM: 0, t: T0 + 1000, speedMps: 0 });
    expect(e.sigmaM).toBeGreaterThan(0);
    expect(haversineM(HOME, e)).toBeGreaterThan(1);
  });

  it('interpolates across the antimeridian the short way', () => {
    const k = new PositionKalman();
    k.update({ lat: 0, lng: 179.9999, accuracyM: 5, t: T0, speedMps: 0 });
    const e = k.update({ lat: 0, lng: -179.9999, accuracyM: 5, t: T0 + 1000, speedMps: 0 });
    expect(Math.abs(e.lng)).toBeGreaterThan(179.999);
  });

  it('forgets its state on reset', () => {
    const k = new PositionKalman();
    k.update({ ...HOME, accuracyM: 5, t: T0, speedMps: 0 });
    k.reset();
    expect(k.estimate).toBeNull();
    const far = destinationPoint(HOME, 0, 500);
    expect(k.update({ ...far, accuracyM: 5, t: T0 + 1000, speedMps: 0 })).toMatchObject({ lat: far.lat, lng: far.lng });
  });
});
