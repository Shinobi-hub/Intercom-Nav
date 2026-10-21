import { z } from 'zod';
import { fetchJson, ProviderError, type FetchFn } from '../fetchJson';
import type { RoutedPath, RoutingProvider } from './types';

const position = z.array(z.number()).min(2).transform((c): [number, number] => [c[0]!, c[1]!]);

const responseSchema = z.object({
  code: z.string(),
  routes: z
    .array(
      z.object({
        geometry: z.object({ coordinates: z.array(position) }),
        distance: z.number().nonnegative(),
        duration: z.number().nonnegative(),
      }),
    )
    .optional(),
});

/** Parses an OSRM `/route/v1` response requested with `geometries=geojson`. */
export function parseOsrmRoute(json: unknown): RoutedPath {
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) throw new ProviderError('unexpected OSRM response');
  const route = parsed.data.routes?.[0];
  if (parsed.data.code !== 'Ok' || !route) throw new ProviderError(`OSRM: ${parsed.data.code}`);
  return { geometry: route.geometry.coordinates, distanceM: route.distance, durationS: route.duration };
}

export function createOsrmProvider(opts: { baseUrl: string; fetch: FetchFn; timeoutMs: number }): RoutingProvider {
  return {
    name: 'osrm',
    profile: 'car',
    async route(points) {
      const coords = points.map((p) => `${p.lng},${p.lat}`).join(';');
      const url = `${opts.baseUrl}/route/v1/driving/${coords}?overview=full&geometries=geojson`;
      return parseOsrmRoute(await fetchJson(opts.fetch, url, { timeoutMs: opts.timeoutMs }));
    },
  };
}
