// @vitest-environment node
import { destinationPoint } from '@intercom/shared';
import { describe, expect, it } from 'vitest';
import { FixFilter, impliedSpeedMps } from './filter';
import { rawFix } from './testing';

const HOME = { lat: 18.52, lng: 73.85 };
const T0 = 1_700_000_000_000;

/** A fix `meters` north of HOME at `sec` seconds after T0. */
const at = (sec: number, meters = 0, accuracy = 5) =>
  rawFix({ ...destinationPoint(HOME, 0, meters), accuracy, timestamp: T0 + sec * 1000 });

describe('FixFilter', () => {
  it('accepts a good first fix', () => {
    expect(new FixFilter().check(at(0))).toEqual({ accepted: true, discontinuity: false });
  });

  it('rejects malformed fixes', () => {
    const f = new FixFilter();
    expect(f.check({ ...at(0), lat: Number.NaN })).toEqual({ accepted: false, reason: 'invalid' });
    expect(f.check({ ...at(0), lat: 91 })).toEqual({ accepted: false, reason: 'invalid' });
    expect(f.check({ ...at(0), lng: -181 })).toEqual({ accepted: false, reason: 'invalid' });
    expect(f.check({ ...at(0), accuracy: -1 })).toEqual({ accepted: false, reason: 'invalid' });
    expect(f.check({ ...at(0), accuracy: Number.POSITIVE_INFINITY })).toEqual({ accepted: false, reason: 'invalid' });
    expect(f.check({ ...at(0), timestamp: 0 })).toEqual({ accepted: false, reason: 'invalid' });
    expect(f.check(at(0)).accepted).toBe(true);
  });

  it('rejects fixes that are not newer than the last accepted one', () => {
    const f = new FixFilter();
    expect(f.check(at(10)).accepted).toBe(true);
    expect(f.check(at(10, 3))).toEqual({ accepted: false, reason: 'out_of_order' });
    expect(f.check(at(9, 3))).toEqual({ accepted: false, reason: 'out_of_order' });
    expect(f.check(at(11, 3)).accepted).toBe(true);
  });

  it('drops fixes worse than 50 m while good ones keep arriving', () => {
    const f = new FixFilter();
    expect(f.check(at(0, 0, 8)).accepted).toBe(true);
    expect(f.check(at(1, 0, 50)).accepted).toBe(true);
    expect(f.check(at(2, 0, 51))).toEqual({ accepted: false, reason: 'inaccurate' });
    expect(f.check(at(19, 0, 120))).toEqual({ accepted: false, reason: 'inaccurate' });
  });

  it('accepts up to 150 m once no good fix arrived for 20 s, until a good one does', () => {
    const f = new FixFilter();
    expect(f.check(at(0, 0, 10)).accepted).toBe(true);
    expect(f.check(at(19.9, 0, 120)).accepted).toBe(false);
    expect(f.check(at(20, 0, 151))).toEqual({ accepted: false, reason: 'inaccurate' });
    expect(f.check(at(20, 0, 120))).toEqual({ accepted: true, discontinuity: false });
    // Still nothing better: coarse fixes keep coming through so the rider doesn't freeze.
    expect(f.check(at(21, 10, 140)).accepted).toBe(true);
    // A good fix ends the relaxation.
    expect(f.check(at(22, 10, 6)).accepted).toBe(true);
    expect(f.check(at(23, 10, 80))).toEqual({ accepted: false, reason: 'inaccurate' });
  });

  it('waits 20 s from the first fix before accepting coarse fixes at cold start', () => {
    const f = new FixFilter();
    expect(f.check(at(0, 0, 90)).accepted).toBe(false);
    expect(f.check(at(10, 0, 90)).accepted).toBe(false);
    expect(f.check(at(20, 0, 90)).accepted).toBe(true);
  });

  it('rejects a physically impossible jump', () => {
    const f = new FixFilter();
    f.check(at(0));
    expect(f.check(at(1, 10_000))).toEqual({ accepted: false, reason: 'jump' });
    // The old position is still the reference.
    expect(f.check(at(2, 20)).accepted).toBe(true);
  });

  it('accepts a jump once three consecutive fixes agree (tunnel exit / bad first fix)', () => {
    const f = new FixFilter();
    f.check(at(0));
    expect(f.check(at(1, 10_000))).toEqual({ accepted: false, reason: 'jump' });
    expect(f.check(at(2, 10_020))).toEqual({ accepted: false, reason: 'jump' });
    expect(f.check(at(3, 10_040))).toEqual({ accepted: true, discontinuity: true });
    // The new position is now the reference.
    expect(f.check(at(4, 10_060))).toEqual({ accepted: true, discontinuity: false });
    expect(f.check(at(5, 60))).toEqual({ accepted: false, reason: 'jump' });
  });

  it('restarts the confirmation when jump candidates disagree with each other', () => {
    const f = new FixFilter();
    f.check(at(0));
    expect(f.check(at(1, 10_000)).accepted).toBe(false);
    expect(f.check(at(2, 30_000)).accepted).toBe(false); // disagrees with the previous candidate
    expect(f.check(at(3, 30_020)).accepted).toBe(false);
    expect(f.check(at(4, 30_040))).toEqual({ accepted: true, discontinuity: true });
  });

  it('requires the agreeing fixes to be consecutive', () => {
    const f = new FixFilter();
    f.check(at(0));
    expect(f.check(at(1, 10_000)).accepted).toBe(false);
    expect(f.check(at(2, 10_020)).accepted).toBe(false);
    expect(f.check(at(3, 30)).accepted).toBe(true); // plausible again: the streak is broken
    expect(f.check(at(4, 10_040)).accepted).toBe(false);
    expect(f.check(at(5, 10_060)).accepted).toBe(false);
    expect(f.check(at(6, 10_080)).accepted).toBe(true);
  });

  it('ignores inaccurate fixes while confirming a jump', () => {
    const f = new FixFilter();
    f.check(at(0));
    expect(f.check(at(1, 10_000)).accepted).toBe(false);
    expect(f.check(at(2, 10_020, 90)).accepted).toBe(false);
    expect(f.check(at(3, 10_040)).accepted).toBe(false);
    expect(f.check(at(4, 10_060)).accepted).toBe(true);
  });

  it('accepts a long move after a long gap (plausible average speed)', () => {
    const f = new FixFilter();
    f.check(at(0));
    // 1.5 km after a 60 s tunnel: 25 m/s.
    expect(f.check(at(60, 1_500))).toEqual({ accepted: true, discontinuity: false });
  });

  it("allows for the fixes' accuracy when judging speed", () => {
    const f = new FixFilter();
    const a = rawFix({ ...HOME, accuracy: 6, timestamp: T0 });
    const b = rawFix({ ...destinationPoint(HOME, 90, 11), accuracy: 6, timestamp: T0 + 50 });
    expect(impliedSpeedMps(a, b)).toBe(0);
    expect(f.check(a).accepted).toBe(true);
    expect(f.check(b).accepted).toBe(true);
  });

  it('forgets everything on reset', () => {
    const f = new FixFilter();
    f.check(at(100));
    f.reset();
    expect(f.check(at(50, 50_000)).accepted).toBe(true);
  });
});
