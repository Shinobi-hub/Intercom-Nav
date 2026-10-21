import { bearingDeg, haversineM, polylineLengthM, type LatLng } from '@intercom/shared';
import { describe, expect, it, vi } from 'vitest';
import { fakeFetch, hangingFetch, jsonResponse, loadFixture } from '../../../test/support/fakeFetch';
import { ProviderError, USER_AGENT } from '../fetchJson';
import { decodePolyline } from '../polyline';
import { createRoutingProvider } from './index';
import { mockRoutePath } from './mock';
import { createOrsProvider, parseOrsRoute } from './ors';
import { createOsrmProvider, parseOsrmRoute } from './osrm';
import { createRoutePlanner } from './planner';
import { straightPath } from './straight';
import { FALLBACK_SPEED_MPS, type RoutingProvider } from './types';
import { createValhallaProvider, parseValhallaRoute } from './valhalla';

const FROM: LatLng = { lat: 18.5204, lng: 73.8567 };
const TO: LatLng = { lat: 18.5304, lng: 73.8667 };
const VIA: LatLng = { lat: 18.525, lng: 73.86 };

describe('valhalla', () => {
  it('posts a motorcycle route request', async () => {
    const { fetch, requests } = fakeFetch(() => jsonResponse(loadFixture('valhalla-route.json')));
    const provider = createValhallaProvider({ baseUrl: 'https://valhalla.test', fetch, timeoutMs: 8000 });
    expect(provider).toMatchObject({ name: 'valhalla', profile: 'motorcycle' });
    await provider.route([FROM, TO]);
    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.url).toBe('https://valhalla.test/route');
    expect(req.method).toBe('POST');
    expect(req.headers['user-agent']).toBe(USER_AGENT);
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.signal).toBeInstanceOf(AbortSignal);
    expect(req.body).toEqual({
      locations: [
        { lat: 18.5204, lon: 73.8567 },
        { lat: 18.5304, lon: 73.8667 },
      ],
      costing: 'motorcycle',
      directions_type: 'none',
      units: 'kilometers',
    });
  });

  it('parses a real response', () => {
    const path = parseValhallaRoute(loadFixture('valhalla-route.json'));
    expect(path.distanceM).toBeCloseTo(2173, 6);
    expect(path.durationS).toBeCloseTo(594.297, 6);
    expect(path.geometry[0]![1]).toBeCloseTo(18.5204, 3);
    expect(path.geometry[0]![0]).toBeCloseTo(73.8568, 3);
    // Valhalla's length and our own measurement of its shape agree.
    expect(polylineLengthM(path.geometry)).toBeCloseTo(path.distanceM, -1);
  });

  it('joins multi-leg shapes without repeating the via point', () => {
    const json = loadFixture('valhalla-route-2legs.json') as { trip: { legs: { shape: string }[] } };
    const legs = json.trip.legs.map((l) => decodePolyline(l.shape, 6));
    const path = parseValhallaRoute(json);
    expect(path.geometry).toHaveLength(legs[0]!.length + legs[1]!.length - 1);
    expect(path.geometry.slice(0, legs[0]!.length)).toEqual(legs[0]);
    expect(path.distanceM).toBeCloseTo(2803, 6);
  });

  it('turns error responses into ProviderErrors', async () => {
    const { fetch } = fakeFetch(() => jsonResponse(loadFixture('valhalla-error.json'), 400));
    const provider = createValhallaProvider({ baseUrl: 'https://valhalla.test', fetch, timeoutMs: 8000 });
    await expect(provider.route([FROM, TO])).rejects.toMatchObject({ name: 'ProviderError', status: 400 });
    expect(() => parseValhallaRoute({ trip: { legs: [] } })).toThrow(ProviderError);
    expect(() => parseValhallaRoute({ trip: { legs: [{ shape: '_' }], summary: { length: 1, time: 1 } } })).toThrow(
      /shape/,
    );
  });
});

describe('osrm', () => {
  it('requests GeoJSON geometry for lng,lat pairs', async () => {
    const { fetch, requests } = fakeFetch(() => jsonResponse(loadFixture('osrm-route.json')));
    const provider = createOsrmProvider({ baseUrl: 'https://osrm.test', fetch, timeoutMs: 8000 });
    expect(provider).toMatchObject({ name: 'osrm', profile: 'car' });
    const path = await provider.route([FROM, VIA, TO]);
    expect(requests[0]!.url).toBe(
      'https://osrm.test/route/v1/driving/73.8567,18.5204;73.86,18.525;73.8667,18.5304?overview=full&geometries=geojson',
    );
    expect(requests[0]!.method).toBe('GET');
    expect(requests[0]!.headers['user-agent']).toBe(USER_AGENT);
    expect(path.geometry).toHaveLength(113);
    expect(path.distanceM).toBe(2986.6);
    expect(path.durationS).toBe(237.1);
  });

  it('rejects responses without a route', () => {
    expect(() => parseOsrmRoute({ code: 'NoRoute', message: 'Impossible route between points' })).toThrow(/NoRoute/);
    expect(() => parseOsrmRoute({ code: 'Ok', routes: [] })).toThrow(ProviderError);
    expect(() => parseOsrmRoute('nope')).toThrow(ProviderError);
  });
});

describe('openrouteservice', () => {
  it('posts lng,lat coordinates with the API key', async () => {
    const { fetch, requests } = fakeFetch(() => jsonResponse(loadFixture('ors-route.json')));
    const provider = createOrsProvider({ baseUrl: 'https://ors.test', apiKey: 'k3y', fetch, timeoutMs: 8000 });
    expect(provider).toMatchObject({ name: 'ors', profile: 'car' });
    const path = await provider.route([FROM, TO]);
    const req = requests[0]!;
    expect(req.url).toBe('https://ors.test/v2/directions/driving-car/geojson');
    expect(req.method).toBe('POST');
    expect(req.headers.authorization).toBe('k3y');
    expect(req.body).toEqual({
      coordinates: [
        [73.8567, 18.5204],
        [73.8667, 18.5304],
      ],
    });
    // Elevation (third value) is dropped.
    expect(path.geometry[0]).toEqual([73.856481, 18.520374]);
    expect(path.distanceM).toBe(412.3);
    expect(path.durationS).toBe(61.8);
  });

  it('treats omitted summary values as zero and rejects other shapes', () => {
    const zero = parseOrsRoute({
      features: [{ geometry: { coordinates: [[1, 2], [1, 2]] }, properties: { summary: {} } }],
    });
    expect(zero).toEqual({ geometry: [[1, 2], [1, 2]], distanceM: 0, durationS: 0 });
    expect(() => parseOrsRoute({ error: { code: 2010, message: 'no routable point' } })).toThrow(ProviderError);
  });
});

describe('provider plumbing', () => {
  it('times out slow providers', async () => {
    const provider = createValhallaProvider({ baseUrl: 'https://valhalla.test', fetch: hangingFetch, timeoutMs: 30 });
    await expect(provider.route([FROM, TO])).rejects.toThrow(/timed out after 30 ms/);
  });

  it('reports network failures and bad JSON without leaking request details', async () => {
    const down = createOsrmProvider({
      baseUrl: 'https://osrm.test',
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
      timeoutMs: 1000,
    });
    const err = (await down.route([FROM, TO]).then(
      () => new Error('expected a failure'),
      (e: unknown) => e as Error,
    ));
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toBe('request failed');
    expect(err.message).not.toContain('18.52');

    const garbled = createOsrmProvider({ baseUrl: 'https://osrm.test', fetch: async () => new Response('<html>'), timeoutMs: 1000 });
    await expect(garbled.route([FROM, TO])).rejects.toThrow(/invalid JSON/);
  });

  it('builds the configured provider', () => {
    const cfg = {
      valhallaUrl: 'https://v',
      osrmUrl: 'https://o',
      orsUrl: 'https://r',
      orsApiKey: 'k',
    };
    for (const provider of ['valhalla', 'osrm', 'ors', 'mock'] as const) {
      expect(createRoutingProvider({ ...cfg, provider }, fetch, 1000).name).toBe(provider);
    }
  });
});

describe('mock routing', () => {
  it('densifies to ~100 m steps with exact endpoints and waypoints', () => {
    const path = mockRoutePath([FROM, VIA, TO]);
    expect(path.geometry[0]).toEqual([FROM.lng, FROM.lat]);
    expect(path.geometry).toContainEqual([VIA.lng, VIA.lat]);
    expect(path.geometry[path.geometry.length - 1]).toEqual([TO.lng, TO.lat]);
    for (let i = 1; i < path.geometry.length; i++) {
      const [a, b] = [path.geometry[i - 1]!, path.geometry[i]!];
      expect(haversineM({ lng: a[0], lat: a[1] }, { lng: b[0], lat: b[1] })).toBeLessThan(110);
    }
  });

  it('wiggles a little, deterministically', () => {
    const a = mockRoutePath([FROM, TO]);
    expect(mockRoutePath([FROM, TO])).toEqual(a);
    const straight = haversineM(FROM, TO);
    expect(a.distanceM).toBeGreaterThan(straight);
    expect(a.distanceM).toBeLessThan(straight * 1.05);
    expect(a.distanceM).toBe(polylineLengthM(a.geometry));
    expect(a.durationS).toBeCloseTo(a.distanceM / FALLBACK_SPEED_MPS, 9);
    // Every point stays within the wiggle amplitude of the straight segment.
    const bearing = bearingDeg(FROM, TO);
    for (const [lng, lat] of a.geometry) {
      const d = haversineM(FROM, { lng, lat });
      const off = Math.abs(Math.sin(((bearingDeg(FROM, { lng, lat }) - bearing) * Math.PI) / 180) * d);
      expect(off).toBeLessThan(13);
    }
  });
});

describe('straight fallback', () => {
  it('connects the points with straight segments at 16.7 m/s', () => {
    const path = straightPath([FROM, VIA, TO]);
    expect(path.geometry).toEqual([
      [FROM.lng, FROM.lat],
      [VIA.lng, VIA.lat],
      [TO.lng, TO.lat],
    ]);
    expect(path.distanceM).toBeCloseTo(haversineM(FROM, VIA) + haversineM(VIA, TO), 6);
    expect(path.durationS).toBeCloseTo(path.distanceM / 16.7, 6);
  });
});

describe('route planner', () => {
  function counting(provider: RoutingProvider) {
    const route = vi.fn(provider.route.bind(provider));
    return { provider: { ...provider, route }, route };
  }

  it('returns the provider route, rounded and simplified to the point limit', async () => {
    const long: LatLng = { lat: 19.076, lng: 72.8777 }; // Pune -> Mumbai, ~120 km: ~1200 mock points
    const planner = createRoutePlanner({
      provider: { name: 'mock', profile: 'motorcycle', route: async (pts) => mockRoutePath(pts) },
      now: () => 0,
      maxPoints: 300,
    });
    const planned = await planner.plan([FROM, long]);
    expect(planned.provider).toBe('mock');
    expect(planned.profile).toBe('motorcycle');
    expect(planned.geometry.length).toBeLessThanOrEqual(300);
    expect(planned.geometry[0]).toEqual([FROM.lng, FROM.lat]);
    for (const [lng, lat] of planned.geometry) {
      expect(Math.round(lng * 1e6) / 1e6).toBe(lng);
      expect(Math.round(lat * 1e6) / 1e6).toBe(lat);
    }
    expect(planned.distanceM).toBe(mockRoutePath([FROM, long]).distanceM);
  });

  it('caches by rounded coordinates for 10 minutes', async () => {
    let t = 0;
    const { provider, route } = counting({ name: 'mock', profile: 'motorcycle', route: async (p) => mockRoutePath(p) });
    const planner = createRoutePlanner({ provider, now: () => t });
    const first = await planner.plan([FROM, TO]);
    const nearby = await planner.plan([{ lat: FROM.lat + 0.00001, lng: FROM.lng }, TO]);
    expect(nearby).toBe(first);
    expect(route).toHaveBeenCalledTimes(1);
    await planner.plan([FROM, VIA]);
    expect(route).toHaveBeenCalledTimes(2);
    t += 10 * 60_000;
    await planner.plan([FROM, TO]);
    expect(route).toHaveBeenCalledTimes(3);
  });

  it('falls back to a straight line when the provider fails, without caching the failure', async () => {
    const onProviderError = vi.fn();
    let fail = true;
    const planner = createRoutePlanner({
      provider: {
        name: 'valhalla',
        profile: 'motorcycle',
        route: async (p) => {
          if (fail) throw new ProviderError('HTTP 503', 503);
          return mockRoutePath(p);
        },
      },
      now: () => 0,
      onProviderError,
    });
    const planned = await planner.plan([FROM, VIA, TO]);
    expect(planned).toMatchObject({ provider: 'straight', profile: 'straight' });
    expect(planned.geometry).toHaveLength(3);
    expect(planned.durationS).toBeCloseTo(planned.distanceM / 16.7, 6);
    expect(onProviderError).toHaveBeenCalledWith(expect.any(ProviderError));
    fail = false;
    expect((await planner.plan([FROM, VIA, TO])).provider).toBe('valhalla');
  });

  it('rejects routes that end far from the requested points', async () => {
    const { fetch } = fakeFetch(() => jsonResponse(loadFixture('osrm-far-snap.json')));
    const planner = createRoutePlanner({
      provider: createOsrmProvider({ baseUrl: 'https://osrm.test', fetch, timeoutMs: 1000 }),
      now: () => 0,
    });
    const ocean = [
      { lat: 10, lng: -30 },
      { lat: 10.5, lng: -30.5 },
    ];
    expect((await planner.plan(ocean)).provider).toBe('straight');
  });

  it('rejects degenerate provider output', async () => {
    const planner = createRoutePlanner({
      provider: { name: 'osrm', profile: 'car', route: async () => ({ geometry: [[1, 1]], distanceM: 1, durationS: 1 }) },
      now: () => 0,
    });
    expect((await planner.plan([FROM, TO])).provider).toBe('straight');
    const nan = createRoutePlanner({
      provider: {
        name: 'osrm',
        profile: 'car',
        route: async () => ({ geometry: [[FROM.lng, FROM.lat], [TO.lng, TO.lat]], distanceM: Number.NaN, durationS: 1 }),
      },
      now: () => 0,
    });
    expect((await nan.plan([FROM, TO])).provider).toBe('straight');
  });

  it('always returns at least two points', async () => {
    const planner = createRoutePlanner({
      provider: { name: 'mock', profile: 'motorcycle', route: async (p) => mockRoutePath(p) },
      now: () => 0,
    });
    expect((await planner.plan([FROM, FROM])).geometry).toEqual([
      [FROM.lng, FROM.lat],
      [FROM.lng, FROM.lat],
    ]);
  });
});
