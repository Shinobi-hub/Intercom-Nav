import type { LngLatTuple } from '@intercom/shared';
import { z } from 'zod';
import { fetchJson, ProviderError, type FetchFn } from '../fetchJson';
import { decodePolyline } from '../polyline';
import type { RoutedPath, RoutingProvider } from './types';

const responseSchema = z.object({
  trip: z.object({
    legs: z.array(z.object({ shape: z.string() })).min(1),
    summary: z.object({ length: z.number().nonnegative(), time: z.number().nonnegative() }),
  }),
});

/** Parses a Valhalla `/route` response (units: kilometers, shapes: polyline6). */
export function parseValhallaRoute(json: unknown): RoutedPath {
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) throw new ProviderError('unexpected Valhalla response');
  const { legs, summary } = parsed.data.trip;
  const geometry: LngLatTuple[] = [];
  for (const leg of legs) {
    let coords: LngLatTuple[];
    try {
      coords = decodePolyline(leg.shape, 6);
    } catch {
      throw new ProviderError('invalid Valhalla shape');
    }
    // Each leg starts where the previous one ended.
    const last = geometry[geometry.length - 1];
    const first = coords[0];
    if (last && first && last[0] === first[0] && last[1] === first[1]) coords.shift();
    geometry.push(...coords);
  }
  return { geometry, distanceM: summary.length * 1000, durationS: summary.time };
}

export function createValhallaProvider(opts: { baseUrl: string; fetch: FetchFn; timeoutMs: number }): RoutingProvider {
  return {
    name: 'valhalla',
    profile: 'motorcycle',
    async route(points) {
      const json = await fetchJson(opts.fetch, `${opts.baseUrl}/route`, {
        method: 'POST',
        body: {
          locations: points.map((p) => ({ lat: p.lat, lon: p.lng })),
          costing: 'motorcycle',
          directions_type: 'none',
          units: 'kilometers',
        },
        timeoutMs: opts.timeoutMs,
      });
      return parseValhallaRoute(json);
    },
  };
}
