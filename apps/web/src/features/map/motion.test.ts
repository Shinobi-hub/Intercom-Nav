// @vitest-environment node
import { destinationPoint, haversineM, TIMING } from '@intercom/shared';
import { describe, expect, it } from 'vitest';
import { MotionTrack, type MotionFix } from './motion';

const HOME = { lat: 18.52, lng: 73.85 };
const T0 = 1_700_000_000_000;

/** A fix `meters` east of HOME, taken `ms` after T0. */
function east(meters: number, ms: number, extra: Partial<MotionFix> = {}): MotionFix {
  return { ...destinationPoint(HOME, 90, meters), hdg: 90, spd: 10, t: T0 + ms, ...extra };
}

/** Meters east of HOME of a drawn position (all test motion is along the same parallel). */
const eastOf = (p: { lat: number; lng: number }) => Math.sign(p.lng - HOME.lng) * haversineM(HOME, { lat: HOME.lat, lng: p.lng });

describe('MotionTrack', () => {
  it('has nothing to draw before the first fix', () => {
    expect(new MotionTrack().sample(0)).toBeNull();
  });

  it('draws the first fix where it is', () => {
    const m = new MotionTrack();
    m.push(east(0, 0), 1000);
    const s = m.sample(1000)!;
    expect(haversineM(s, HOME)).toBeLessThan(1e-6);
    expect(s).toMatchObject({ hdg: 90, state: 'live', extrapolating: false, ageMs: 0 });
  });

  it('glides at constant velocity to a new fix over the observed update interval', () => {
    const m = new MotionTrack();
    m.push(east(0, 0, { spd: 0 }), 0);
    m.push(east(20, 1000, { spd: 0 }), 1000);
    expect(eastOf(m.sample(1000)!)).toBeCloseTo(0, 3);
    expect(eastOf(m.sample(1250)!)).toBeCloseTo(5, 1);
    expect(eastOf(m.sample(1500)!)).toBeCloseTo(10, 1);
    expect(eastOf(m.sample(1750)!)).toBeCloseTo(15, 1);
    expect(eastOf(m.sample(2000)!)).toBeCloseTo(20, 1);
    expect(eastOf(m.sample(2600)!)).toBeCloseTo(20, 1); // spd 0: no dead reckoning
  });

  it('smooths the glide duration over irregular intervals and clamps it to 250-2000 ms', () => {
    const glideOf = (intervals: number[]) => {
      const m = new MotionTrack();
      let now = 0;
      m.push(east(0, 0, { spd: 0 }), now);
      intervals.forEach((dt, i) => {
        now += dt;
        m.push(east((i + 1) * 100, now, { spd: 0 }), now);
      });
      // Find when the glide toward the last fix ends.
      const end = m.fix!;
      for (let t = now; t < now + 5000; t += 10) {
        if (haversineM(m.sample(t)!, end) < 0.01) return t - now;
      }
      return Infinity;
    };
    expect(glideOf([1000])).toBe(1000);
    expect(glideOf([1000, 2000])).toBe(1300);
    expect(glideOf([100])).toBe(250);
    expect(glideOf([60_000])).toBe(2000);
  });

  it('starts each glide from where the marker is drawn, so it never jumps', () => {
    const m = new MotionTrack();
    m.push(east(0, 0), 0);
    m.push(east(10, 1000), 1000);
    const before = m.sample(1400)!;
    m.push(east(20, 1400), 1400); // early fix, mid-glide
    expect(haversineM(m.sample(1400)!, before)).toBeLessThan(1e-6);
    const later = m.sample(1500)!;
    expect(eastOf(later)).toBeGreaterThan(eastOf(before));
  });

  it('dead-reckons along the heading for up to 3 s after arriving, then holds', () => {
    const m = new MotionTrack();
    m.push(east(0, 0), 0);
    m.push(east(10, 1000), 1000); // glide 1000 ms, arrives at 2000
    expect(m.sample(1999)!.extrapolating).toBe(false);
    const one = m.sample(3000)!;
    expect(one.extrapolating).toBe(true);
    expect(eastOf(one)).toBeCloseTo(20, 1);
    expect(eastOf(m.sample(2000 + TIMING.deadReckonMaxMs - 1)!)).toBeCloseTo(40, 0);
    const held = m.sample(2000 + TIMING.deadReckonMaxMs + 5000)!;
    expect(held.extrapolating).toBe(false);
    expect(eastOf(held)).toBeCloseTo(40, 1);
  });

  it('glides from the dead-reckoned position when a late fix arrives', () => {
    const m = new MotionTrack();
    m.push(east(0, 0), 0);
    m.push(east(10, 1000), 1000);
    const drawn = m.sample(3500)!; // 1.5 s of dead reckoning: 25 m east
    m.push(east(32, 3500), 3500);
    expect(haversineM(m.sample(3500)!, drawn)).toBeLessThan(1e-6);
    expect(m.sample(3500)!.extrapolating).toBe(false);
  });

  it('does not dead-reckon slow riders or riders without a heading', () => {
    const slow = new MotionTrack();
    slow.push(east(0, 0, { spd: 0.8 }), 0);
    expect(eastOf(slow.sample(2000)!)).toBeCloseTo(0, 3);

    const noHeading = new MotionTrack();
    noHeading.push({ ...HOME, hdg: null, spd: 10, t: T0 }, 0);
    expect(noHeading.sample(2000)).toMatchObject({ lat: HOME.lat, lng: HOME.lng, extrapolating: false });
  });

  it('teleports instead of gliding across more than 2 km', () => {
    const m = new MotionTrack();
    m.push(east(0, 0, { spd: 0 }), 0);
    m.push(east(2_500, 1000, { spd: 0 }), 1000);
    expect(eastOf(m.sample(1000)!)).toBeCloseTo(2_500, 0);
    const near = new MotionTrack();
    near.push(east(0, 0, { spd: 0 }), 0);
    near.push(east(1_900, 1000, { spd: 0 }), 1000);
    expect(eastOf(near.sample(1000)!)).toBeCloseTo(0, 0);
  });

  it('turns the short way round', () => {
    const m = new MotionTrack();
    m.push(east(0, 0, { hdg: 350, spd: 0 }), 0);
    m.push(east(0.5, 1000, { hdg: 10, spd: 0 }), 1000);
    const mid = m.sample(1500)!.hdg!;
    expect(Math.min(mid, 360 - mid)).toBeLessThan(0.01);
    expect(m.sample(1250)!.hdg).toBeCloseTo(355, 6);
    expect(m.sample(2000)!.hdg).toBeCloseTo(10, 6);
  });

  it('derives the heading from movement when a fix has none, else keeps the drawn one', () => {
    const m = new MotionTrack();
    m.push(east(0, 0, { hdg: 30, spd: 0 }), 0);
    m.push(east(1, 1000, { hdg: null, spd: 0 }), 1000); // moved 1 m: keep 30
    expect(m.sample(3000)!.hdg).toBeCloseTo(30, 6);
    m.push(east(20, 2000, { hdg: null, spd: 0 }), 2000);
    expect(m.sample(4000)!.hdg).toBeCloseTo(90, 1);
  });

  it('derives the dead-reckoning speed from fix times when a fix has none', () => {
    const m = new MotionTrack();
    m.push(east(0, 0, { spd: null }), 0);
    m.push(east(15, 1000, { spd: null }), 1000); // 15 m/s
    expect(eastOf(m.sample(3000)!)).toBeCloseTo(30, 0); // arrived at 2000, +1 s of dead reckoning
  });

  it('turns stale and lost by time since the newest fix was received', () => {
    const m = new MotionTrack();
    m.push(east(0, 0), 0);
    expect(m.sample(TIMING.riderStaleMs - 1)!.state).toBe('live');
    expect(m.sample(TIMING.riderStaleMs)!.state).toBe('stale');
    expect(m.sample(TIMING.riderLostMs)).toMatchObject({ state: 'lost', ageMs: TIMING.riderLostMs });
    m.push(east(0, 70_000), TIMING.riderLostMs + 1);
    expect(m.sample(TIMING.riderLostMs + 1)!.state).toBe('live');
  });

  it('shows a fix that arrived already old as-is: no glide, no dead reckoning, aged state', () => {
    const m = new MotionTrack();
    m.push(east(0, 0), 10_000, 3 * 60_000);
    expect(m.lastReceivedAt).toBe(10_000 - 3 * 60_000);
    expect(m.sample(10_000)).toMatchObject({ state: 'lost', extrapolating: false });
    expect(haversineM(m.sample(10_000)!, HOME)).toBeLessThan(1e-6);
    expect(haversineM(m.sample(14_000)!, HOME)).toBeLessThan(1e-6);
    // The next live fix is live again and glides from the old position like any other.
    m.push(east(30, 200_000), 20_000);
    expect(m.sample(20_000)!.state).toBe('live');
    expect(haversineM(m.sample(20_000)!, HOME)).toBeLessThan(1e-6);
    expect(eastOf(m.sample(20_500)!)).toBeCloseTo(15, 0);
  });

  it('ignores repeated and older fixes', () => {
    const m = new MotionTrack();
    expect(m.push(east(0, 1000, { spd: 0 }), 0)).toBe(true);
    expect(m.push(east(50, 1000), 500)).toBe(false);
    expect(m.push(east(50, 900), 600)).toBe(false);
    expect(eastOf(m.sample(700)!)).toBeCloseTo(0, 3);
  });

  it('glides across the antimeridian the short way', () => {
    const m = new MotionTrack();
    m.push({ lat: 0, lng: 179.9999, hdg: 90, spd: 0, t: T0 }, 0);
    m.push({ lat: 0, lng: -179.9999, hdg: 90, spd: 0, t: T0 + 1000 }, 1000);
    const mid = m.sample(1500)!;
    expect(Math.abs(mid.lng)).toBeGreaterThan(179.9998);
  });
});
