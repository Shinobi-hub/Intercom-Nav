import { placeSchema, type Place } from '@intercom/shared';
import type { GeocoderName } from '../../config';
import type { Clock } from '../../util/clock';
import { LruCache } from '../../util/lruCache';
import type { Geocoder, PlaceQuery } from './types';

export interface PlaceSearch {
  readonly geocoderName: GeocoderName;
  /** Rejects when the geocoder fails. */
  search(query: PlaceQuery): Promise<Place[]>;
}

const CACHE_TTL_MS = 30 * 60_000;
/** ~1 km: nearby riders searching the same text share cached results. */
const NEAR_KEY_DECIMALS = 2;

/** Caches results and guarantees they satisfy `placeSchema`, so clients can pass them to `route:set`. */
export function createPlaceSearch(opts: { geocoder: Geocoder; now: Clock; cacheSize?: number; cacheTtlMs?: number }): PlaceSearch {
  const cache = new LruCache<Place[]>({
    maxEntries: opts.cacheSize ?? 500,
    ttlMs: opts.cacheTtlMs ?? CACHE_TTL_MS,
    now: opts.now,
  });

  return {
    geocoderName: opts.geocoder.name,
    async search(query) {
      const near = query.near
        ? `${query.near.lat.toFixed(NEAR_KEY_DECIMALS)},${query.near.lng.toFixed(NEAR_KEY_DECIMALS)}`
        : '';
      const key = `${query.q.toLowerCase()}|${near}|${query.limit}`;
      const cached = cache.get(key);
      if (cached) return cached.map((p) => ({ ...p }));

      const results = sanitizePlaces(await opts.geocoder.search(query)).slice(0, query.limit);
      cache.set(key, results);
      return results.map((p) => ({ ...p }));
    },
  };
}

/** Trims to the schema's length limits, drops invalid entries and exact duplicates. */
export function sanitizePlaces(places: readonly Place[]): Place[] {
  const seen = new Set<string>();
  const out: Place[] = [];
  for (const p of places) {
    const address = p.address?.trim().slice(0, 300).trim();
    const candidate = placeSchema.safeParse({
      name: p.name?.trim().slice(0, 200),
      lat: p.lat,
      lng: p.lng,
      ...(address ? { address } : {}),
    });
    if (!candidate.success) continue;
    const key = `${candidate.data.name.toLowerCase()}|${candidate.data.address?.toLowerCase() ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate.data);
  }
  return out;
}
