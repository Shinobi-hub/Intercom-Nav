import type { VoiceMode } from '@intercom/shared';
import type { FastifyInstance } from 'fastify';
import type { GeocoderName, RoutingProviderName } from '../config';
import type { OriginPolicy } from '../net/originPolicy';
import type { RideStore } from '../rides/store';
import type { Clock } from '../util/clock';

export interface HealthResponse {
  ok: true;
  uptimeS: number;
  rides: number;
  riders: number;
}

export interface ConfigResponse {
  protocolVersion: number;
  voice: { available: VoiceMode[]; defaultMode: VoiceMode };
  maxRiders: number;
  routing: { provider: RoutingProviderName };
  geocoder: GeocoderName;
}

export interface ApiDeps {
  store: RideStore;
  now: Clock;
  startedAt: number;
  originPolicy: OriginPolicy;
  publicConfig: ConfigResponse;
}

export function registerApi(app: FastifyInstance, deps: ApiDeps): void {
  // Native app WebViews (capacitor://localhost, ...) call the API cross-origin.
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    const origin = req.headers.origin;
    if (origin && deps.originPolicy.allowsCrossOrigin(origin)) {
      reply.header('access-control-allow-origin', origin);
      reply.header('vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      return reply
        .header('access-control-allow-methods', 'GET, OPTIONS')
        .header('access-control-allow-headers', 'content-type')
        .header('access-control-max-age', '600')
        .code(204)
        .send();
    }
  });

  app.get('/api/health', async (_req, reply): Promise<HealthResponse> => {
    reply.header('cache-control', 'no-store');
    return {
      ok: true,
      uptimeS: Math.max(0, Math.floor((deps.now() - deps.startedAt) / 1000)),
      rides: deps.store.rideCount,
      riders: deps.store.riderCount,
    };
  });

  app.get('/api/config', async (_req, reply): Promise<ConfigResponse> => {
    reply.header('cache-control', 'no-cache');
    return deps.publicConfig;
  });
}
