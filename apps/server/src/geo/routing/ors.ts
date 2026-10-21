import { z } from 'zod';
import { fetchJson, ProviderError, type FetchFn } from '../fetchJson';
import type { RoutedPath, RoutingProvider } from './types';

// Positions may carry a third (elevation) value.
const position = z.array(z.number()).min(2).transform((c): [number, number] => [c[0]!, c[1]!]);

const responseSchema = z.object({
  features: z
    .array(
      z.object({
        geometry: z.object({ coordinates: z.array(position) }),
        properties: z.object({
          // ORS leaves out zero values.
          summary: z.object({ distance: z.number().nonnegative().optional(), duration: z.number().nonnegative().optional() }),
        }),
      }),
    )
    .min(1),
});

/** Parses an openrouteservice `/v2/directions/{profile}/geojson` response. */
export function parseOrsRoute(json: unknown): RoutedPath {
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) throw new ProviderError('unexpected openrouteservice response');
  const feature = parsed.data.features[0]!;
  return {
    geometry: feature.geometry.coordinates,
    distanceM: feature.properties.summary.distance ?? 0,
    durationS: feature.properties.summary.duration ?? 0,
  };
}

export function createOrsProvider(opts: {
  baseUrl: string;
  apiKey: string;
  fetch: FetchFn;
  timeoutMs: number;
}): RoutingProvider {
  return {
    name: 'ors',
    profile: 'car',
    async route(points) {
      const json = await fetchJson(opts.fetch, `${opts.baseUrl}/v2/directions/driving-car/geojson`, {
        method: 'POST',
        headers: { authorization: opts.apiKey },
        body: { coordinates: points.map((p) => [p.lng, p.lat]) },
        timeoutMs: opts.timeoutMs,
      });
      return parseOrsRoute(json);
    },
  };
}
