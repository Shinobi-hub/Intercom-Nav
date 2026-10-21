// @vitest-environment node
import { haversineM } from '@intercom/shared';
import { describe, expect, it } from 'vitest';
import { circleFeature, circleRing } from './geometry';

describe('circleRing', () => {
  it('is a closed ring of points at the given radius', () => {
    const center = { lat: 18.52, lng: 73.85 };
    const ring = circleRing(center, 25, 32);
    expect(ring).toHaveLength(33);
    expect(ring[0]).toEqual(ring[32]);
    for (const [lng, lat] of ring) expect(haversineM(center, { lat, lng })).toBeCloseTo(25, 6);
  });

  it('wraps into a GeoJSON polygon feature', () => {
    const f = circleFeature({ lat: 0, lng: 0 }, 10);
    expect(f.geometry.type).toBe('Polygon');
    expect(f.geometry.coordinates[0]).toHaveLength(49);
  });
});
