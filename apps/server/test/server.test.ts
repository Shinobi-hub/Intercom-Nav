import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TIMING } from '@intercom/shared';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  call,
  closeAllServers,
  createRide,
  emitRaw,
  flush,
  joinRide,
  newRider,
  nextEvent,
  ok,
  record,
  rideWith,
  sleep,
  startServer,
} from './support/harness';

afterEach(closeAllServers);

const LIVEKIT = { LIVEKIT_URL: 'ws://livekit.test:7880', LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'secret' };
const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString()) as Record<string, any>;

describe('voice', () => {
  it('gives every rider their own LiveKit token and switches transports per socket', async () => {
    const t = await startServer(LIVEKIT);
    const { code, leader, riders } = await rideWith(t, 1);
    const bob = riders[0]!;
    expect(leader.join.voice.mode).toBe('livekit');
    expect(claims(leader.join.voice.livekit!.token)).toMatchObject({ sub: leader.auth.id, video: { room: `ride-${code}` } });
    expect(claims(bob.join.voice.livekit!.token).sub).toBe(bob.auth.id);

    expect(await call(bob.socket, 'voice:setMode', { mode: 'mesh' })).toMatchObject({ error: 'not_leader' });
    const toMesh = [nextEvent(leader.socket, 'voice:mode'), nextEvent(bob.socket, 'voice:mode')];
    expect(await call(leader.socket, 'voice:setMode', { mode: 'mesh' })).toEqual({ ok: true });
    for (const e of await Promise.all(toMesh)) {
      expect(e).toMatchObject({ by: leader.auth.id, voice: { mode: 'mesh', livekit: null, available: ['livekit', 'mesh'] } });
    }
    const [l, b] = await Promise.all([
      nextEvent(leader.socket, 'voice:mode'),
      nextEvent(bob.socket, 'voice:mode'),
      call(leader.socket, 'voice:setMode', { mode: 'livekit' }),
    ]);
    expect(claims(l.voice.livekit!.token).sub).toBe(leader.auth.id);
    expect(claims(b.voice.livekit!.token).sub).toBe(bob.auth.id);

    // Same mode again: nothing to announce. Fresh tokens on demand.
    const quiet = record(bob.socket);
    ok(await call(leader.socket, 'voice:setMode', { mode: 'livekit' }));
    const fresh = ok(await call(bob.socket, 'voice:token', {}));
    expect(fresh.livekit).toMatchObject({ url: LIVEKIT.LIVEKIT_URL, room: `ride-${code}` });
    await flush(leader.socket, bob.socket);
    expect(quiet.of('voice:mode')).toEqual([]);
    expect((await joinRide(t, code, 'Late')).join.voice.mode).toBe('livekit');
  });

  it('is mesh-only without LiveKit and honours requested modes and TURN secrets', async () => {
    const t = await startServer({ TURN_URLS: 'turn:turn.test:3478', TURN_SECRET: 'shh' });
    const { join, socket } = await createRide(t, 'A', { voiceMode: 'livekit' });
    expect(join.voice.mode).toBe('mesh');
    expect(join.voice.iceServers[1]).toMatchObject({ urls: ['turn:turn.test:3478'], username: expect.stringMatching(/^\d+:/) });
    expect(await call(socket, 'voice:setMode', { mode: 'livekit' })).toMatchObject({ error: 'unavailable' });
    expect(await call(socket, 'voice:token', {})).toMatchObject({ error: 'unavailable' });

    const lk = await startServer({ ...LIVEKIT, DEFAULT_VOICE_MODE: 'mesh' });
    expect((await createRide(lk)).join.voice.mode).toBe('mesh');
    expect((await createRide(lk, 'B', { voiceMode: 'livekit' })).join.voice.mode).toBe('livekit');
  });
});

describe('robustness', () => {
  const ackEvents = [
    'ride:create', 'ride:join', 'ride:leave', 'rider:update', 'sos:raise', 'sos:cancel', 'sos:respond', 'break:request',
    'route:set', 'route:clear', 'place:search', 'leader:transfer', 'voice:setMode', 'voice:token',
  ] as const;

  it('answers garbage with invalid_payload or not_in_ride and never crashes', async () => {
    const t = await startServer();
    const { leader } = await rideWith(t, 0);
    const stranger = await t.connect();
    const emptyPayloadEvents = new Set<string>(['ride:leave', 'route:clear', 'voice:token']);
    for (const event of ackEvents) {
      // Events with an empty payload accept null and ignore extra keys; everything else must reject these.
      const garbage = emptyPayloadEvents.has(event) ? [42, 'x', []] : [null, 42, 'x', [], { id: 'nope', to: 1, q: {} }];
      for (const payload of garbage) {
        for (const s of [leader.socket, stranger]) {
          const res = (await call(s, event, payload)) as { ok: boolean; error: string };
          expect(res.ok).toBe(false);
          // With the test clock frozen, the per-socket limits kick in too.
          expect(['invalid_payload', 'not_in_ride', 'rate_limited']).toContain(res.error);
        }
      }
      // No ack, or a non-function where the ack would be: processed or dropped, never fatal.
      emitRaw(leader.socket, event, { bogus: true });
      emitRaw(leader.socket, event, { bogus: true }, 'not-a-function');
      emitRaw(stranger, event);
    }
    emitRaw(leader.socket, 'no:such:event', 1, 2, 3);
    await flush(leader.socket, stranger);
    t.clock.advance(60_000);
    expect(await call(stranger, 'ride:leave', {})).toEqual({ ok: false, error: 'not_in_ride' });
    // Still healthy (the leader itself left via the ack-less ride:leave above, which is processed).
    ok(await call(await t.connect(), 'ride:create', { rider: newRider() }));
  });

  it('rate-limits join attempts per IP, trusting X-Forwarded-For only with TRUST_PROXY', async () => {
    const tryJoin = async (t: Awaited<ReturnType<typeof startServer>>, ip: string) =>
      call(await t.connect({ extraHeaders: { 'x-forwarded-for': ip } }), 'ride:join', { code: 'ZZZZZZ', rider: newRider() });
    const direct = await startServer({ JOIN_PER_MINUTE_PER_IP: '2' });
    expect(await tryJoin(direct, '1.1.1.1')).toMatchObject({ error: 'ride_not_found' });
    expect(await tryJoin(direct, '2.2.2.2')).toMatchObject({ error: 'ride_not_found' });
    expect(await tryJoin(direct, '3.3.3.3')).toMatchObject({ error: 'rate_limited', retryInMs: 30_000 });

    const proxied = await startServer({ JOIN_PER_MINUTE_PER_IP: '1', TRUST_PROXY: '1' });
    expect(await tryJoin(proxied, '1.1.1.1')).toMatchObject({ error: 'ride_not_found' });
    expect(await tryJoin(proxied, '2.2.2.2')).toMatchObject({ error: 'ride_not_found' });
    expect(await tryJoin(proxied, '9.9.9.9, 2.2.2.2')).toMatchObject({ error: 'rate_limited' });
  });
});

describe('sweep', () => {
  it('deletes rides idle for rideIdleTtlMs and moves leadership after leaderGraceMs', async () => {
    const t = await startServer();
    const { code, leader, riders } = await rideWith(t, 1);
    const bob = riders[0]!;
    leader.socket.disconnect();
    await nextEvent(bob.socket, 'rider:updated');
    t.clock.advance(TIMING.leaderGraceMs);
    expect(t.server.sweep().leaderChanges).toEqual([]);
    t.clock.advance(1);
    const changed = nextEvent(bob.socket, 'leader:changed');
    expect(t.server.sweep().leaderChanges).toHaveLength(1);
    expect(await changed).toEqual({ leaderId: bob.auth.id, by: null });

    bob.socket.disconnect();
    await sleep(50);
    t.clock.advance(TIMING.rideIdleTtlMs);
    expect(t.server.sweep().deletedRides).toEqual([code]);
    expect(await call(await t.connect(), 'ride:join', { code, rider: bob.auth })).toMatchObject({ error: 'ride_not_found' });
  });

  it('runs on its own timer', async () => {
    const t = await startServer({ SWEEP_INTERVAL_MS: '20' });
    const { socket } = await createRide(t);
    socket.disconnect();
    await sleep(30);
    t.clock.advance(TIMING.rideIdleTtlMs);
    await sleep(80);
    expect(t.server.store.rideCount).toBe(0);
  });
});

describe('http', () => {
  const web = mkdtempSync(path.join(tmpdir(), 'intercom-web-'));
  mkdirSync(path.join(web, 'assets'));
  for (const f of ['index.html', 'sw.js', 'manifest.webmanifest', 'icon.svg', 'assets/app-Ab12Cd34.js']) {
    writeFileSync(path.join(web, f), f === 'index.html' ? '<!doctype html><title>app</title>' : f);
  }
  afterAll(() => rmSync(web, { recursive: true, force: true }));

  it('serves health and config', async () => {
    const t = await startServer({ ...LIVEKIT, MAX_RIDERS: '6' });
    await rideWith(t, 1);
    t.clock.advance(5_000);
    const health = await t.server.app.inject('/api/health');
    expect(health.json()).toEqual({ ok: true, uptimeS: 5, rides: 1, riders: 2 });
    expect((await t.server.app.inject('/api/config')).json()).toEqual({
      protocolVersion: 1,
      voice: { available: ['livekit', 'mesh'], defaultMode: 'livekit' },
      maxRiders: 6,
      routing: { provider: 'mock' },
      geocoder: 'mock',
    });
  });

  it('serves the web app with cache headers and an SPA fallback', async () => {
    const t = await startServer({ STATIC_DIR: web });
    const get = (url: string, accept = '*/*') => t.server.app.inject({ url, headers: { accept } });
    for (const url of ['/', '/sw.js', '/manifest.webmanifest']) expect((await get(url)).headers['cache-control']).toBe('no-cache');
    expect((await get('/assets/app-Ab12Cd34.js')).headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const spa = await get('/ride/ABCD23', 'text/html,*/*');
    expect(spa.statusCode).toBe(200);
    expect(spa.body).toContain('<title>app</title>');
    expect((await get('/ride/ABCD23')).statusCode).toBe(404);
    expect((await get('/api/nope', 'text/html')).json()).toMatchObject({ error: 'not_found' });
    expect((await get('/assets/missing.js')).statusCode).toBe(404);

    const bare = await startServer();
    const hint = await bare.server.app.inject({ url: '/', headers: { accept: 'text/html' } });
    expect([hint.statusCode, hint.body]).toEqual([404, expect.stringContaining('not built')]);
  });

  it('allows same-origin, CORS_ORIGINS and dev localhost; rejects other origins', async () => {
    const t = await startServer({ CORS_ORIGINS: 'capacitor://localhost' });
    const api = await t.server.app.inject({ url: '/api/config', headers: { origin: 'capacitor://localhost' } });
    expect(api.headers['access-control-allow-origin']).toBe('capacitor://localhost');
    const evilApi = await t.server.app.inject({ url: '/api/config', headers: { origin: 'https://evil.example' } });
    expect(evilApi.headers['access-control-allow-origin']).toBeUndefined();

    for (const origin of [t.url, 'capacitor://localhost', 'http://localhost:5173']) {
      expect((await t.connect({ extraHeaders: { origin } })).connected).toBe(true);
    }
    await expect(t.connect({ extraHeaders: { origin: 'https://evil.example' } })).rejects.toThrow();
    const prod = await startServer({ NODE_ENV: 'production' });
    await expect(prod.connect({ extraHeaders: { origin: 'http://localhost:5173' } })).rejects.toThrow();
  });
});
