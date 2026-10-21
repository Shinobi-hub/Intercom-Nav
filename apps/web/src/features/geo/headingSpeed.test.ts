// @vitest-environment node
import { destinationPoint } from '@intercom/shared';
import { describe, expect, it } from 'vitest';
import { HeadingSpeedEstimator } from './headingSpeed';

const HOME = { lat: 18.52, lng: 73.85 };
const T0 = 1_700_000_000_000;
const NONE = { speed: null, heading: null };

const point = (bearing: number, meters: number, ms: number) => ({ ...destinationPoint(HOME, bearing, meters), t: T0 + ms });

describe('HeadingSpeedEstimator', () => {
  it('uses the provider heading and speed while moving', () => {
    const h = new HeadingSpeedEstimator();
    expect(h.update(point(0, 0, 0), { speed: 12, heading: 271 })).toEqual({ spd: 12, hdg: 271 });
  });

  it('normalizes provider headings into [0, 360)', () => {
    const h = new HeadingSpeedEstimator();
    expect(h.update(point(0, 0, 0), { speed: 5, heading: 360 }).hdg).toBe(0);
    expect(h.update(point(0, 5, 1000), { speed: 5, heading: -10 }).hdg).toBe(350);
  });

  it('ignores the provider heading when crawling and has no heading until moved 8 m', () => {
    const h = new HeadingSpeedEstimator();
    expect(h.update(point(0, 0, 0), { speed: 1.0, heading: 200 })).toEqual({ spd: 1.0, hdg: null });
    expect(h.update(point(90, 5, 5000), { speed: 1.0, heading: 200 }).hdg).toBeNull();
    const moved = h.update(point(90, 9, 9000), { speed: 1.0, heading: 200 });
    expect(moved.hdg).toBeCloseTo(90, 0);
  });

  it('falls back to the bearing between smoothed fixes when the provider has no heading', () => {
    const h = new HeadingSpeedEstimator();
    h.update(point(0, 0, 0), { speed: 10, heading: null });
    expect(h.update(point(135, 10, 1000), { speed: 10, heading: null }).hdg).toBeCloseTo(135, 0);
  });

  it('keeps the last heading when stopped', () => {
    const h = new HeadingSpeedEstimator();
    h.update(point(0, 0, 0), { speed: 10, heading: 45 });
    expect(h.update(point(0, 1, 1000), { speed: 0, heading: null })).toEqual({ spd: 0, hdg: 45 });
    expect(h.update(point(200, 3, 30_000), { speed: 0, heading: 300 })).toEqual({ spd: 0, hdg: 45 });
  });

  it('measures bearings from where the heading was last set, so slow drift adds up', () => {
    const h = new HeadingSpeedEstimator();
    h.update(point(0, 0, 0), NONE);
    for (let i = 1; i <= 4; i++) expect(h.update(point(180, i * 1.5, i * 1000), NONE).hdg).toBeNull();
    expect(h.update(point(180, 10, 5000), NONE).hdg).toBeCloseTo(180, 0);
  });

  it('derives speed from smoothed fixes when the provider has none', () => {
    const h = new HeadingSpeedEstimator();
    expect(h.update(point(0, 0, 0), NONE).spd).toBeNull();
    let last = h.update(point(0, 15, 1000), NONE);
    for (let i = 2; i <= 6; i++) last = h.update(point(0, 15 * i, i * 1000), NONE);
    expect(last.spd).toBeCloseTo(15, 1);
    expect(last.hdg).toBeCloseTo(0, 0);
  });

  it('does not derive wild speeds from bursts of fixes', () => {
    const h = new HeadingSpeedEstimator();
    h.update(point(0, 0, 0), NONE);
    // 3 m of jitter 50 ms later would be 60 m/s; too short a baseline to say anything.
    expect(h.update(point(90, 3, 50), NONE).spd).toBeNull();
    expect(h.update(point(0, 1, 1000), NONE).spd).toBeCloseTo(1, 1);
  });

  it('derives speed across sparse fixes up to 10 s apart', () => {
    const h = new HeadingSpeedEstimator();
    h.update(point(0, 0, 0), NONE);
    expect(h.update(point(0, 80, 8000), NONE).spd).toBeCloseTo(10, 1);
    expect(h.update(point(0, 200, 20_000), NONE).spd).toBeNull();
  });

  it('prefers a provider speed of 0 over a derived one', () => {
    const h = new HeadingSpeedEstimator();
    h.update(point(0, 0, 0), NONE);
    expect(h.update(point(0, 30, 2000), { speed: 0, heading: null }).spd).toBe(0);
  });

  it('forgets everything on reset', () => {
    const h = new HeadingSpeedEstimator();
    h.update(point(0, 0, 0), { speed: 10, heading: 90 });
    h.reset();
    expect(h.update(point(0, 0, 1000), NONE)).toEqual({ spd: null, hdg: null });
  });
});
