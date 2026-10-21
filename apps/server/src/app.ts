import { PROTOCOL_VERSION } from '@intercom/shared';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import type { Config } from './config';
import { createGeocoder, createPlaceSearch, type Geocoder } from './geo/geocoding';
import type { FetchFn } from './geo/fetchJson';
import { createRoutePlanner, createRoutingProvider, type RoutingProvider } from './geo/routing';
import { registerApi } from './http/api';
import { registerStatic } from './http/static';
import { loggerOptions } from './logger';
import { createOriginPolicy } from './net/originPolicy';
import { RideStore, type SweepResult } from './rides/store';
import { handleConnection } from './socket/connection';
import { announceLeaderChange, rideRoom, type ServerContext } from './socket/context';
import { createSocketServer, type IoServer } from './socket/io';
import { systemClock, type Clock } from './util/clock';
import { KeyedRateLimiter, perMinute } from './util/rateLimit';
import { errorMessage } from './util/result';
import { createVoiceService } from './voice/service';

export interface ServerDeps {
  now?: Clock;
  fetch?: FetchFn;
  /** Overrides the provider chosen by ROUTING_PROVIDER. */
  routingProvider?: RoutingProvider;
  /** Overrides the geocoder chosen by GEOCODER. */
  geocoder?: Geocoder;
  generateRideCode?: () => string;
}

export interface RideServer {
  app: FastifyInstance;
  io: IoServer;
  store: RideStore;
  /** Runs the periodic housekeeping now (it also runs every TIMING sweep interval). */
  sweep(): SweepResult;
  close(): Promise<void>;
}

export function buildServer(config: Config, deps: ServerDeps = {}): RideServer {
  const now = deps.now ?? systemClock;
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const startedAt = now();
  const hops = config.trustProxyHops;

  const app = Fastify({
    logger: loggerOptions(config),
    // Same rule as for sockets: believe only the X-Forwarded-For entries our own proxies added.
    trustProxy: hops > 0 ? (_address: string, hop: number) => hop < hops : false,
    logController: new LogController({ disableRequestLogging: (req) => req.url === '/api/health' }),
  });
  const log = app.log;

  const originPolicy = createOriginPolicy({ allowedOrigins: config.corsOrigins, allowLocalhost: !config.production });
  const store = new RideStore({
    now,
    maxRiders: config.maxRiders,
    timing: config.timing,
    generateCode: deps.generateRideCode,
  });
  const voice = createVoiceService(config.voice, now);
  const routing = deps.routingProvider ?? createRoutingProvider(config.routing, fetchFn, config.providerTimeoutMs);
  const routes = createRoutePlanner({
    provider: routing,
    now,
    onProviderError: (err) =>
      log.warn({ provider: routing.name, reason: errorMessage(err) }, 'routing failed, falling back to a straight line'),
  });
  const geocoder = deps.geocoder ?? createGeocoder(config.geocoder, fetchFn, config.providerTimeoutMs);
  const places = createPlaceSearch({ geocoder, now });

  const io = createSocketServer(app.server, { originPolicy, trustProxyHops: hops });
  const ctx: ServerContext = {
    io,
    store,
    voice,
    routes,
    places,
    now,
    log,
    joinLimiter: new KeyedRateLimiter(perMinute(config.joinPerMinutePerIp), now),
  };
  io.on('connection', (socket) => handleConnection(ctx, socket, hops));

  registerApi(app, {
    store,
    now,
    startedAt,
    originPolicy,
    publicConfig: {
      protocolVersion: PROTOCOL_VERSION,
      voice: { available: [...voice.available], defaultMode: voice.defaultMode },
      maxRiders: config.maxRiders,
      routing: { provider: routing.name },
      geocoder: geocoder.name,
    },
  });
  registerStatic(app, config.staticDir);

  const sweep = (): SweepResult => {
    const result = store.sweep();
    for (const code of result.deletedRides) {
      io.in(rideRoom(code)).socketsLeave(rideRoom(code));
      log.info({ code }, 'idle ride deleted');
    }
    for (const change of result.leaderChanges) {
      const ride = store.get(change.code);
      if (ride) announceLeaderChange(ctx, ride, change, null);
      log.info({ code: change.code, leaderId: change.leaderId }, 'leadership moved from an offline leader');
    }
    ctx.joinLimiter.prune();
    return result;
  };
  const sweepTimer = setInterval(() => {
    try {
      sweep();
    } catch (err) {
      log.error({ err }, 'sweep failed');
    }
  }, config.timing.sweepIntervalMs);
  sweepTimer.unref();

  // Sockets hold their HTTP connections open, so they must go before the HTTP server can close.
  app.addHook('preClose', async () => {
    io.disconnectSockets(true);
    io.engine.close();
  });

  let closing: Promise<void> | null = null;
  return {
    app,
    io,
    store,
    sweep,
    close() {
      clearInterval(sweepTimer);
      closing ??= app.close();
      return closing;
    },
  };
}
