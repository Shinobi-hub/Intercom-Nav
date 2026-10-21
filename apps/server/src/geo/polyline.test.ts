import { haversineM } from '@intercom/shared';
import { describe, expect, it } from 'vitest';
import { loadFixture } from '../../test/support/fakeFetch';
import { decodePolyline, encodePolyline } from './polyline';
import { simplifyLine, simplifyToMaxPoints } from './simplify';

const fixture = (name: string) =>
  loadFixture(name) as {
    trip: { legs: { shape: string }[]; summary: { min_lat: number; max_lat: number; min_lon: number; max_lon: number } };
  };

describe('decodePolyline', () => {
  it("decodes Google's reference sample (precision 5)", () => {
    // https://developers.google.com/maps/documentation/utilities/polylinealgorithm
    expect(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 5)).toEqual([
      [-120.2, 38.5],
      [-120.95, 40.7],
      [-126.453, 43.252],
    ]);
  });

  it('decodes a real Valhalla shape (precision 6) to the bounds Valhalla reported', () => {
    const { trip } = fixture('valhalla-route.json');
    const coords = decodePolyline(trip.legs[0]!.shape, 6);
    expect(coords.length).toBeGreaterThan(50);
    const lats = coords.map((c) => c[1]);
    const lngs = coords.map((c) => c[0]);
    // Valhalla prints its bounds with slightly less precision than the shape carries.
    expect(Math.min(...lats)).toBeCloseTo(trip.summary.min_lat, 5);
    expect(Math.max(...lats)).toBeCloseTo(trip.summary.max_lat, 5);
    expect(Math.min(...lngs)).toBeCloseTo(trip.summary.min_lon, 5);
    expect(Math.max(...lngs)).toBeCloseTo(trip.summary.max_lon, 5);
    // The request went from 18.5204,73.8567 to 18.5304,73.8667.
    expect(haversineM({ lng: coords[0]![0], lat: coords[0]![1] }, { lat: 18.5204, lng: 73.8567 })).toBeLessThan(50);
    const end = coords[coords.length - 1]!;
    expect(haversineM({ lng: end[0], lat: end[1] }, { lat: 18.5304, lng: 73.8667 })).toBeLessThan(50);
  });

  it('round-trips through the encoder at both precisions', () => {
    const coords: [number, number][] = [
      [73.856825, 18.520403],
      [-0.000001, 0.000001],
      [179.999999, -89.999999],
      [-180, 90],
    ];
    expect(decodePolyline(encodePolyline(coords, 6), 6)).toEqual(coords);
    expect(decodePolyline(encodePolyline([[-120.2, 38.5]], 5), 5)).toEqual([[-120.2, 38.5]]);
    expect(encodePolyline([[-120.2, 38.5], [-120.95, 40.7], [-126.453, 43.252]], 5)).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  });

  it('decodes an empty string to no points and rejects corrupt input', () => {
    expect(decodePolyline('')).toEqual([]);
    expect(() => decodePolyline('_p~iF~ps|U_', 5)).toThrow(/Truncated/);
    expect(() => decodePolyline('_p~iF\u0001', 5)).toThrow(/Invalid/);
    expect(() => decodePolyline('~'.repeat(40))).toThrow();
  });
});

describe('simplify', () => {
  const line = (n: number, f: (i: number) => number): [number, number][] =>
    Array.from({ length: n }, (_, i) => [73.8 + i * 0.0001, 18.5 + f(i)]);

  it('drops collinear points', () => {
    expect(simplifyLine(line(500, () => 0), 1)).toEqual([line(500, () => 0)[0], line(500, () => 0)[499]]);
  });

  it('keeps vertices that deviate more than the tolerance', () => {
    // A tent: straight up to a ~110 m peak and straight back down.
    const tent = line(101, (i) => (50 - Math.abs(i - 50)) * 0.00002);
    expect(simplifyLine(tent, 10)).toEqual([tent[0], tent[50], tent[100]]);
    expect(simplifyLine(tent, 200)).toEqual([tent[0], tent[100]]);
  });

  it('measures distance to the segment, so U-turns survive', () => {
    const uTurn: [number, number][] = [
      [73.8, 18.5],
      [73.81, 18.5],
      [73.805, 18.5],
    ];
    expect(simplifyLine(uTurn, 50)).toEqual(uTurn);
  });

  it('fits long lines under the point limit while keeping the ends', () => {
    const wiggly = line(20_000, (i) => Math.sin(i / 7) * 0.0005);
    const out = simplifyToMaxPoints(wiggly, 2_000);
    expect(out.length).toBeLessThanOrEqual(2_000);
    expect(out.length).toBeGreaterThan(1_000);
    expect(out[0]).toEqual(wiggly[0]);
    expect(out[out.length - 1]).toEqual(wiggly[wiggly.length - 1]);
  });

  it('leaves short lines alone and copes with tiny limits', () => {
    const short = line(10, (i) => i * 0.001);
    expect(simplifyToMaxPoints(short, 2_000)).toEqual(short);
    expect(simplifyToMaxPoints(line(100, (i) => (i % 2) * 0.01), 1)).toHaveLength(2);
  });
});
