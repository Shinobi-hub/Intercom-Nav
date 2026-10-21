import type { Config } from '../../config';
import type { FetchFn } from '../fetchJson';
import { createMockGeocoder } from './mock';
import { createNominatimGeocoder } from './nominatim';
import { createPhotonGeocoder } from './photon';
import type { Geocoder } from './types';

export type { Geocoder, PlaceQuery } from './types';
export { createPlaceSearch, type PlaceSearch } from './placeSearch';

export function createGeocoder(cfg: Config['geocoder'], fetch: FetchFn, timeoutMs: number): Geocoder {
  switch (cfg.provider) {
    case 'photon':
      return createPhotonGeocoder({ baseUrl: cfg.photonUrl, fetch, timeoutMs });
    case 'nominatim':
      return createNominatimGeocoder({ baseUrl: cfg.nominatimUrl, fetch, timeoutMs });
    case 'mock':
      return createMockGeocoder();
  }
}
