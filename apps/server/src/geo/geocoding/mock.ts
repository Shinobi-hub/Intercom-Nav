import { destinationPoint, type LatLng, type Place } from '@intercom/shared';
import type { Geocoder, PlaceQuery } from './types';

/** Pune city centre, used when the query has no `near`. */
export const MOCK_GEOCODER_CENTER: LatLng = { lat: 18.5204, lng: 73.8567 };
const OFFSETS_KM = [1, 5, 20];

/** Deterministic offline results: "<q> 1/2/3" at 1, 5 and 20 km north-east of `near`. */
export function mockPlaces({ q, near, limit }: PlaceQuery): Place[] {
  const center = near ?? MOCK_GEOCODER_CENTER;
  return OFFSETS_KM.slice(0, limit).map((km, i) => {
    const p = destinationPoint(center, 45, km * 1000);
    return { name: `${q} ${i + 1}`, lat: p.lat, lng: p.lng, address: `${km} km north-east (mock)` };
  });
}

export function createMockGeocoder(): Geocoder {
  return { name: 'mock', search: async (query) => mockPlaces(query) };
}
