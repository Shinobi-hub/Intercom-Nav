import type { Config } from '../../config';
import type { FetchFn } from '../fetchJson';
import { createMockRoutingProvider } from './mock';
import { createOrsProvider } from './ors';
import { createOsrmProvider } from './osrm';
import type { RoutingProvider } from './types';
import { createValhallaProvider } from './valhalla';

export type { RoutingProvider, RoutedPath } from './types';
export { createRoutePlanner, type PlannedRoute, type RoutePlanner } from './planner';

export function createRoutingProvider(cfg: Config['routing'], fetch: FetchFn, timeoutMs: number): RoutingProvider {
  switch (cfg.provider) {
    case 'valhalla':
      return createValhallaProvider({ baseUrl: cfg.valhallaUrl, fetch, timeoutMs });
    case 'osrm':
      return createOsrmProvider({ baseUrl: cfg.osrmUrl, fetch, timeoutMs });
    case 'ors':
      return createOrsProvider({ baseUrl: cfg.orsUrl, apiKey: cfg.orsApiKey ?? '', fetch, timeoutMs });
    case 'mock':
      return createMockRoutingProvider();
  }
}
