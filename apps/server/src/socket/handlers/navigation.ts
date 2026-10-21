import { randomUUID } from 'node:crypto';
import { placeSearchSchema, routeSetSchema, type RideRoute } from '@intercom/shared';
import type { TokenBucket } from '../../util/rateLimit';
import { errorMessage, fail } from '../../util/result';
import { rideRoom, type ServerContext } from '../context';
import { emptyPayload, type EventRouter } from '../router';

const DEFAULT_PLACE_RESULTS = 5;

/** route:set, route:clear, place:search. */
export function registerNavigationHandlers(
  ctx: ServerContext,
  router: EventRouter,
  limits: { route: TokenBucket; search: TokenBucket },
): void {
  const { store, io, log } = ctx;

  router.ride(
    'route:set',
    routeSetSchema,
    async (input, { code, riderId }, call) => {
      const start = store.startRoute(code, riderId, input.origin);
      if (!start.ok) return start;
      const waypoints = input.waypoints ?? [];
      const planned = await ctx.routes.plan([start.origin, ...waypoints, input.destination]);
      const route: RideRoute = {
        id: randomUUID(),
        destination: input.destination,
        waypoints,
        geometry: planned.geometry,
        distanceM: planned.distanceM,
        durationS: planned.durationS,
        provider: planned.provider,
        profile: planned.profile,
        setBy: riderId,
        setAt: ctx.now(),
      };
      const committed = store.commitRoute(start.ride, riderId, start.seq, route);
      if (!committed.ok) return committed;
      log.info({ code, provider: route.provider, points: route.geometry.length }, 'route set');
      call.afterAck(() => io.to(rideRoom(code)).emit('route:updated', { route, by: riderId }));
      return { ok: true, route };
    },
    limits.route,
  );

  router.ride('route:clear', emptyPayload, (_input, { code, riderId }, call) => {
    const res = store.clearRoute(code, riderId);
    if (!res.ok) return res;
    if (res.changed) call.afterAck(() => io.to(rideRoom(code)).emit('route:updated', { route: null, by: riderId }));
    return { ok: true };
  });

  router.ride(
    'place:search',
    placeSearchSchema,
    async ({ q, near, limit }) => {
      try {
        const results = await ctx.places.search({ q, near, limit: limit ?? DEFAULT_PLACE_RESULTS });
        return { ok: true, results };
      } catch (err) {
        log.warn({ geocoder: ctx.places.geocoderName, reason: errorMessage(err) }, 'place search failed');
        return fail('geocode_failed', 'Place search is unavailable right now');
      }
    },
    limits.search,
  );
}
