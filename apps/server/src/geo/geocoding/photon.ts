import type { Place } from '@intercom/shared';
import { z } from 'zod';
import { fetchJson, ProviderError, type FetchFn } from '../fetchJson';
import type { Geocoder } from './types';

const featureSchema = z.object({
  geometry: z.object({ coordinates: z.array(z.number()).min(2) }),
  properties: z.object({
    name: z.string().optional(),
    street: z.string().optional(),
    housenumber: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    country: z.string().optional(),
  }),
});

const responseSchema = z.object({ features: z.array(z.unknown()) });

/** Parses Photon's GeoJSON. Features we can't use are skipped rather than failing the search. */
export function parsePhotonResults(json: unknown): Place[] {
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) throw new ProviderError('unexpected Photon response');
  const places: Place[] = [];
  for (const raw of parsed.data.features) {
    const feature = featureSchema.safeParse(raw);
    if (!feature.success) continue;
    const [lng, lat] = feature.data.geometry.coordinates as [number, number];
    const p = feature.data.properties;
    const streetLine = p.street ? [p.street, p.housenumber].filter(Boolean).join(' ') : undefined;
    const name = p.name ?? streetLine ?? p.city ?? p.state ?? p.country;
    if (!name) continue;
    const address = [...new Set([streetLine, p.city, p.state, p.country])]
      .filter((part): part is string => Boolean(part) && part !== name)
      .join(', ');
    places.push({ name, lat, lng, ...(address ? { address } : {}) });
  }
  return places;
}

export function createPhotonGeocoder(opts: { baseUrl: string; fetch: FetchFn; timeoutMs: number }): Geocoder {
  return {
    name: 'photon',
    async search({ q, near, limit }) {
      const params = new URLSearchParams({ q, limit: String(limit) });
      if (near) {
        params.set('lat', String(near.lat));
        params.set('lon', String(near.lng));
      }
      const json = await fetchJson(opts.fetch, `${opts.baseUrl}/api/?${params}`, { timeoutMs: opts.timeoutMs });
      return parsePhotonResults(json);
    },
  };
}
