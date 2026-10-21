import { destinationPoint, type LatLng } from '@intercom/shared';
import type { Feature, FeatureCollection, LineString, Polygon } from 'geojson';

/** Closed [lng, lat] ring approximating a circle of `radiusM` around `center` (GeoJSON polygon ring). */
export function circleRing(center: LatLng, radiusM: number, steps = 48): [number, number][] {
  const ring: [number, number][] = [];
  for (let i = 0; i < steps; i++) {
    const p = destinationPoint(center, (360 * i) / steps, Math.max(0, radiusM));
    ring.push([p.lng, p.lat]);
  }
  ring.push(ring[0]!);
  return ring;
}

export function circleFeature(center: LatLng, radiusM: number): Feature<Polygon> {
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [circleRing(center, radiusM)] } };
}

export function lineFeature(coords: [number, number][]): Feature<LineString> {
  return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } };
}

export const EMPTY_COLLECTION: FeatureCollection = { type: 'FeatureCollection', features: [] };
