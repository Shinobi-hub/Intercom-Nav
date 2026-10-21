import { describe, expect, it } from 'vitest';
import {
  angleDiffDeg,
  bearingDeg,
  destinationPoint,
  formatRideCode,
  generateRideCode,
  haversineM,
  isValidRideCode,
  lerpAngleDeg,
  locationFixSchema,
  normalizeDeg,
  normalizeLng,
  normalizeRideCode,
  polylineLengthM,
  randomSecret,
  rideJoinSchema,
  RIDE_CODE_ALPHABET,
  rtcSignalSchema,
  uuid,
} from './index';

describe('ride codes', () => {
  it('generates valid codes from the unambiguous alphabet', () => {
    for (let i = 0; i < 500; i++) {
      const code = generateRideCode();
      expect(isValidRideCode(code)).toBe(true);
      for (const c of code) expect(RIDE_CODE_ALPHABET).toContain(c);
    }
  });

  it('normalizes case and separators', () => {
    expect(normalizeRideCode('abc-d23')).toBe('ABCD23');
    expect(normalizeRideCode(' ab c d 2 3 ')).toBe('ABCD23');
    expect(formatRideCode('ABCD23')).toBe('ABC-D23');
  });

  it('rejects look-alike characters instead of guessing', () => {
    expect(isValidRideCode(normalizeRideCode('ABC0D2'))).toBe(false);
    expect(isValidRideCode('ABCD2')).toBe(false);
  });
});

describe('ids', () => {
  it('makes v4 uuids and url-safe secrets', () => {
    expect(uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const s = randomSecret();
    expect(s.length).toBeGreaterThanOrEqual(30);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('geo', () => {
  const london = { lat: 51.5007, lng: -0.1246 };
  const paris = { lat: 48.8584, lng: 2.2945 };

  it('measures great-circle distance', () => {
    expect(haversineM(london, paris) / 1000).toBeCloseTo(340.5, 0);
    expect(haversineM(london, london)).toBe(0);
  });

  it('round-trips bearing and destination point', () => {
    const b = bearingDeg(london, paris);
    expect(b).toBeGreaterThan(140);
    expect(b).toBeLessThan(160);
    const d = haversineM(london, paris);
    const p = destinationPoint(london, b, d);
    expect(haversineM(p, paris)).toBeLessThan(5);
  });

  it('handles angle wrap-around', () => {
    expect(normalizeDeg(-10)).toBe(350);
    expect(normalizeDeg(720)).toBe(0);
    expect(angleDiffDeg(350, 10)).toBe(20);
    expect(angleDiffDeg(10, 350)).toBe(-20);
    expect(lerpAngleDeg(350, 10, 0.5)).toBeCloseTo(0, 6);
    expect(normalizeLng(190)).toBe(-170);
  });

  it('sums polyline length', () => {
    const line: [number, number][] = [
      [london.lng, london.lat],
      [paris.lng, paris.lat],
      [london.lng, london.lat],
    ];
    expect(polylineLengthM(line)).toBeCloseTo(2 * haversineM(london, paris), 3);
  });
});

describe('schemas', () => {
  const fix = { lat: 18.52, lng: 73.85, acc: 8, spd: 12.5, hdg: 270, t: Date.now() };

  it('accepts a normal fix and rejects out-of-range values', () => {
    expect(locationFixSchema.safeParse(fix).success).toBe(true);
    expect(locationFixSchema.safeParse({ ...fix, lat: 91 }).success).toBe(false);
    expect(locationFixSchema.safeParse({ ...fix, spd: Number.NaN }).success).toBe(false);
    expect(locationFixSchema.safeParse({ ...fix, hdg: null, spd: null }).success).toBe(true);
  });

  it('normalizes the ride code inside join payloads', () => {
    const parsed = rideJoinSchema.parse({
      code: 'abc-d23',
      rider: { id: uuid(), secret: randomSecret(), name: '  Sam ', color: '#0A84FF' },
    });
    expect(parsed.code).toBe('ABCD23');
    expect(parsed.rider.name).toBe('Sam');
  });

  it('requires a description or candidate in rtc signals', () => {
    expect(rtcSignalSchema.safeParse({ to: uuid(), data: {} }).success).toBe(false);
    expect(
      rtcSignalSchema.safeParse({ to: uuid(), data: { description: { type: 'offer', sdp: 'v=0' } } }).success,
    ).toBe(true);
  });
});
