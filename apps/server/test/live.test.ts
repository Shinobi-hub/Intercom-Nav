// Opt-in smoke test against the real public providers: LIVE_PROVIDERS=1 npx vitest run --project server test/live
import { haversineM } from '@intercom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createGeocoder } from '../src/geo/geocoding';
import { createRoutePlanner, createRoutingProvider } from '../src/geo/routing';
import { loadConfig } from '../src/config';
import { mintLiveKitToken } from '../src/voice/livekit';
import { closeAllServers, ok, rideWith, startServer, type AckResults } from './support/harness';

const live = process.env.LIVE_PROVIDERS === '1';
const cfg = loadConfig(process.env);
const PUNE = { lat: 18.5204, lng: 73.8567 };
const LONAVALA = { lat: 18.7546, lng: 73.4062 };

afterEach(closeAllServers);

describe.skipIf(!live)('live providers', { timeout: 30_000 }, () => {
  const routers = ['valhalla', 'osrm', ...(cfg.routing.orsApiKey ? ['ors' as const] : [])] as const;
  for (const name of routers) {
    it(`routes Pune -> Lonavala with ${name}`, async () => {
      const errors: unknown[] = [];
      const planner = createRoutePlanner({
        provider: createRoutingProvider({ ...cfg.routing, provider: name }, fetch, 15_000),
        now: Date.now,
        onProviderError: (e) => errors.push(e),
      });
      const route = await planner.plan([PUNE, LONAVALA]);
      expect(errors).toEqual([]);
      expect(route.provider).toBe(name);
      const straight = haversineM(PUNE, LONAVALA);
      expect(route.distanceM).toBeGreaterThan(straight);
      expect(route.distanceM).toBeLessThan(straight * 2);
      console.info(`${name}: ${(route.distanceM / 1000).toFixed(1)} km, ${(route.durationS / 60).toFixed(0)} min, ${route.geometry.length} points`);
    });
  }

  for (const name of ['photon', 'nominatim'] as const) {
    it(`finds Shaniwar Wada with ${name}`, async () => {
      const geocoder = createGeocoder({ ...cfg.geocoder, provider: name }, fetch, 15_000);
      const results = await geocoder.search({ q: 'Shaniwar Wada', near: PUNE, limit: 3 });
      expect(results.length).toBeGreaterThan(0);
      expect(haversineM(PUNE, results[0]!)).toBeLessThan(5_000);
      console.info(`${name}: ${results.map((r) => `${r.name} (${r.address ?? ''})`).join('; ')}`);
    });
  }

  it('serves route:set and place:search end to end with the default providers', async () => {
    const t = await startServer({ ROUTING_PROVIDER: 'valhalla', GEOCODER: 'photon', PROVIDER_TIMEOUT_MS: '15000' });
    const { leader } = await rideWith(t, 0);
    // Real providers can be slower than the harness's 5 s ack timeout.
    const slowCall = (event: string, payload: unknown) =>
      (leader.socket.timeout(20_000) as unknown as { emitWithAck(e: string, p: unknown): Promise<unknown> }).emitWithAck(event, payload);
    const places = ok((await slowCall('place:search', { q: 'Lonavala', near: PUNE })) as AckResults['place:search']);
    expect(places.results.length).toBeGreaterThan(0);
    const route = ok((await slowCall('route:set', { destination: places.results[0], origin: PUNE })) as AckResults['route:set']);
    expect(route.route.provider).toBe('valhalla');
  });

  it('mints tokens the local LiveKit dev server accepts', async () => {
    const lk = cfg.voice.livekit ?? { url: 'ws://127.0.0.1:7880', apiKey: 'devkey', apiSecret: 'secret' };
    const token = await mintLiveKitToken(lk, { room: 'ride-LIVE22', identity: 'live-test', name: 'Live test' });
    const res = await fetch(`${lk.url.replace(/^ws/, 'http')}/rtc/validate?access_token=${token}`);
    expect(res.status).toBe(200);
  });
});
