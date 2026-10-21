import { clamp, type Place } from '@intercom/shared';
import { z } from 'zod';
import { fetchJson, ProviderError, type FetchFn } from '../fetchJson';
import type { Geocoder } from './types';

const itemSchema = z.object({
  lat: z.coerce.number(),
  lon: z.coerce.number(),
  name: z.string().optional(),
  display_name: z.string().optional(),
});

/** Half-size of the box used to prefer results near the rider (Nominatim has no point bias). */
const BIAS_BOX_DEG = 0.5;

/** Parses a `/search?format=jsonv2` response. Unusable entries are skipped. */
export function parseNominatimResults(json: unknown): Place[] {
  if (!Array.isArray(json)) throw new ProviderError('unexpected Nominatim response');
  const places: Place[] = [];
  for (const raw of json) {
    const item = itemSchema.safeParse(raw);
    if (!item.success) continue;
    const display = item.data.display_name?.trim() ?? '';
    const name = item.data.name?.trim() || display.split(',')[0]?.trim();
    if (!name) continue;
    const address = display.startsWith(`${name},`) ? display.slice(name.length + 1).trim() : display;
    places.push({
      name,
      lat: item.data.lat,
      lng: item.data.lon,
      ...(address && address !== name ? { address } : {}),
    });
  }
  return places;
}

export function createNominatimGeocoder(opts: { baseUrl: string; fetch: FetchFn; timeoutMs: number }): Geocoder {
  return {
    name: 'nominatim',
    async search({ q, near, limit }) {
      const params = new URLSearchParams({ q, format: 'jsonv2', limit: String(limit) });
      if (near) {
        const box = [
          clamp(near.lng - BIAS_BOX_DEG, -180, 180),
          clamp(near.lat + BIAS_BOX_DEG, -90, 90),
          clamp(near.lng + BIAS_BOX_DEG, -180, 180),
          clamp(near.lat - BIAS_BOX_DEG, -90, 90),
        ];
        params.set('viewbox', box.join(','));
      }
      const json = await fetchJson(opts.fetch, `${opts.baseUrl}/search?${params}`, { timeoutMs: opts.timeoutMs });
      return parseNominatimResults(json);
    },
  };
}
