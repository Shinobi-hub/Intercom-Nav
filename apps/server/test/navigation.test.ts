import { haversineM, LIMITS, polylineLengthM } from '@intercom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderError } from '../src/geo/fetchJson';
import { mockRoutePath } from '../src/geo/routing/mock';
import {
  call,
  closeAllServers,
  emitRaw,
  fix,
  flush,
  joinRide,
  ok,
  record,
  rideWith,
  sleep,
  startServer,
} from './support/harness';

afterEach(closeAllServers);

const PUNE = { lat: 18.5204, lng: 73.8567 };
const LONAVALA = { name: 'Lonavala', lat: 18.7546, lng: 73.4062, address: 'Maharashtra, India' };
const KHANDALA = { name: 'Khandala', lat: 18.7645, lng: 73.3846 };

describe('route:set', () => {
  it('computes the route with the configured provider and broadcasts it', async () => {
    const t = await startServer();
    const { code, leader, riders } = await rideWith(t, 1);
    const bobEvents = record(riders[0]!.socket);
    const res = ok(await call(leader.socket, 'route:set', { destination: LONAVALA, waypoints: [KHANDALA], origin: PUNE }));
    const route = res.route;
    expect(route).toMatchObject({
      id: expect.any(String),
      destination: LONAVALA,
      waypoints: [KHANDALA],
      provider: 'mock',
      profile: 'motorcycle',
      setBy: leader.auth.id,
      setAt: t.clock.t,
    });
    expect(route.geometry[0]).toEqual([PUNE.lng, PUNE.lat]);
    expect(route.geometry[route.geometry.length - 1]).toEqual([LONAVALA.lng, LONAVALA.lat]);
    expect(route.geometry).toContainEqual([KHANDALA.lng, KHANDALA.lat]);
    expect(route.geometry.length).toBeLessThanOrEqual(LIMITS.maxRoutePoints);
    expect(route.distanceM).toBeCloseTo(polylineLengthM(route.geometry), -1);
    expect(route.durationS).toBeCloseTo(route.distanceM / 16.7, 6);

    await flush(leader.socket, riders[0]!.socket);
    expect(bobEvents.of('route:updated')).toEqual([{ route, by: leader.auth.id }]);
    expect((await joinRide(t, code, 'Late')).join.snapshot.route).toEqual(route);
  });

  it("starts from the leader's last location when no origin is given", async () => {
    const t = await startServer();
    const { leader } = await rideWith(t, 0);
    expect(await call(leader.socket, 'route:set', { destination: LONAVALA })).toMatchObject({ ok: false, error: 'no_origin' });
    emitRaw(leader.socket, 'loc:update', fix(1, 18.53, 73.85));
    const res = ok(await call(leader.socket, 'route:set', { destination: LONAVALA }));
    expect(res.route.geometry[0]).toEqual([73.85, 18.53]);
    expect(res.route.waypoints).toEqual([]);
  });

  it('is for the leader only', async () => {
    const t = await startServer();
    const { riders } = await rideWith(t, 1);
    expect(await call(riders[0]!.socket, 'route:set', { destination: LONAVALA, origin: PUNE })).toMatchObject({
      ok: false,
      error: 'not_leader',
    });
  });

  it('validates destinations and waypoint count', async () => {
    const t = await startServer();
    const { leader } = await rideWith(t, 0);
    const tooMany = Array.from({ length: LIMITS.maxWaypoints + 1 }, () => KHANDALA);
    expect(await call(leader.socket, 'route:set', { destination: LONAVALA, origin: PUNE, waypoints: tooMany })).toEqual({
      ok: false,
      error: 'invalid_payload',
    });
    expect(await call(leader.socket, 'route:set', { destination: { name: '', lat: 1, lng: 2 }, origin: PUNE })).toMatchObject({
      error: 'invalid_payload',
    });
  });

  it('falls back to a straight line when routing fails', async () => {
    const t = await startServer(
      {},
      {
        routingProvider: {
          name: 'valhalla',
          profile: 'motorcycle',
          route: async () => {
            throw new ProviderError('HTTP 503', 503);
          },
        },
      },
    );
    const { leader } = await rideWith(t, 0);
    const res = ok(await call(leader.socket, 'route:set', { destination: LONAVALA, waypoints: [KHANDALA], origin: PUNE }));
    expect(res.route).toMatchObject({ provider: 'straight', profile: 'straight' });
    expect(res.route.geometry).toEqual([
      [PUNE.lng, PUNE.lat],
      [KHANDALA.lng, KHANDALA.lat],
      [LONAVALA.lng, LONAVALA.lat],
    ]);
    const straight = haversineM(PUNE, KHANDALA) + haversineM(KHANDALA, LONAVALA);
    expect(res.route.distanceM).toBeCloseTo(straight, 3);
    expect(res.route.durationS).toBeCloseTo(straight / 16.7, 3);
  });

  it('keeps the newest route when an older computation finishes last', async () => {
    let slowFirst = true;
    const t = await startServer(
      {},
      {
        routingProvider: {
          name: 'osrm',
          profile: 'car',
          route: async (points) => {
            if (slowFirst) {
              slowFirst = false;
              await sleep(150);
            }
            return mockRoutePath(points);
          },
        },
      },
    );
    const { leader, riders } = await rideWith(t, 1);
    const bobEvents = record(riders[0]!.socket);
    const older = call(leader.socket, 'route:set', { destination: LONAVALA, origin: PUNE });
    await sleep(20);
    const newer = ok(await call(leader.socket, 'route:set', { destination: KHANDALA, origin: PUNE }));
    expect(await older).toMatchObject({ ok: false, error: 'route_failed' });
    await flush(leader.socket, riders[0]!.socket);
    expect(bobEvents.of('route:updated').map((u) => u.route?.destination.name)).toEqual(['Khandala']);
    expect(newer.route.destination.name).toBe('Khandala');
  });

  it(`allows ${LIMITS.routeSetPerMinute} route changes per minute`, async () => {
    const t = await startServer();
    const { leader } = await rideWith(t, 0);
    for (let i = 0; i < LIMITS.routeSetPerMinute; i++) {
      ok(await call(leader.socket, 'route:set', { destination: LONAVALA, origin: PUNE }));
    }
    expect(await call(leader.socket, 'route:set', { destination: LONAVALA, origin: PUNE })).toMatchObject({
      ok: false,
      error: 'rate_limited',
      retryInMs: 10_000,
    });
  });
});

describe('route:clear', () => {
  it('clears the route for everyone (leader only)', async () => {
    const t = await startServer();
    const { code, leader, riders } = await rideWith(t, 1);
    ok(await call(leader.socket, 'route:set', { destination: LONAVALA, origin: PUNE }));
    expect(await call(riders[0]!.socket, 'route:clear', {})).toMatchObject({ error: 'not_leader' });
    await flush(leader.socket, riders[0]!.socket);
    const bobEvents = record(riders[0]!.socket);
    expect(await call(leader.socket, 'route:clear', {})).toEqual({ ok: true });
    // Clearing nothing is fine and quiet.
    ok(await call(leader.socket, 'route:clear'));
    await flush(leader.socket, riders[0]!.socket);
    expect(bobEvents.of('route:updated')).toEqual([{ route: null, by: leader.auth.id }]);
    expect((await joinRide(t, code, 'Late')).join.snapshot.route).toBeNull();
  });
});

describe('place:search', () => {
  it('searches with the configured geocoder, biased to `near`', async () => {
    const t = await startServer();
    const { leader } = await rideWith(t, 0);
    const near = { lat: 12.9716, lng: 77.5946 };
    const res = ok(await call(leader.socket, 'place:search', { q: '  Fuel  ', near, limit: 8 }));
    expect(res.results.map((p) => p.name)).toEqual(['Fuel 1', 'Fuel 2', 'Fuel 3']);
    expect(haversineM(near, res.results[0]!)).toBeCloseTo(1_000, -1);
    // Without `near` (and with the default limit) the mock centres on Pune.
    const plain = ok(await call(leader.socket, 'place:search', { q: 'chai' }));
    expect(haversineM(PUNE, plain.results[2]!)).toBeCloseTo(20_000, -2);
    // Results are valid route:set destinations.
    ok(await call(leader.socket, 'route:set', { destination: plain.results[0], origin: PUNE }));
  });

  it('validates queries and requires a ride', async () => {
    const t = await startServer();
    const { leader } = await rideWith(t, 0);
    expect(await call(leader.socket, 'place:search', { q: 'a' })).toEqual({ ok: false, error: 'invalid_payload' });
    expect(await call(leader.socket, 'place:search', { q: 'fuel', limit: LIMITS.placeResultsMax + 1 })).toMatchObject({
      error: 'invalid_payload',
    });
    expect(await call(await t.connect(), 'place:search', { q: 'fuel' })).toEqual({ ok: false, error: 'not_in_ride' });
  });

  it('reports geocoder failures as geocode_failed', async () => {
    const t = await startServer(
      {},
      {
        geocoder: {
          name: 'photon',
          search: async () => {
            throw new ProviderError('timed out after 8000 ms');
          },
        },
      },
    );
    const { leader } = await rideWith(t, 0);
    expect(await call(leader.socket, 'place:search', { q: 'fuel' })).toMatchObject({ ok: false, error: 'geocode_failed' });
  });

  it(`allows ${LIMITS.placeSearchPerMinute} searches per minute`, async () => {
    const t = await startServer();
    const { leader } = await rideWith(t, 0);
    for (let i = 0; i < LIMITS.placeSearchPerMinute; i++) ok(await call(leader.socket, 'place:search', { q: `q${i}` }));
    expect(await call(leader.socket, 'place:search', { q: 'more' })).toMatchObject({ error: 'rate_limited' });
  });
});
