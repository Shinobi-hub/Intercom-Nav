import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LIMITS, TIMING } from '@intercom/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigError, configWarnings, DEFAULT_STATIC_DIR, loadConfig, normalizeOrigin } from './config';

const webDist = mkdtempSync(path.join(tmpdir(), 'intercom-config-'));
writeFileSync(path.join(webDist, 'index.html'), '<!doctype html>');
afterAll(() => rmSync(webDist, { recursive: true, force: true }));

describe('loadConfig', () => {
  it('has sensible defaults for an empty environment', () => {
    const c = loadConfig({});
    expect(c.port).toBe(8787);
    expect(c.host).toBe('0.0.0.0');
    expect(c.production).toBe(false);
    expect(c.logLevel).toBe('info');
    expect(c.trustProxyHops).toBe(0);
    expect(c.maxRiders).toBe(LIMITS.maxRidersDefault);
    expect(c.voice.livekit).toBeNull();
    expect(c.voice.defaultMode).toBe('livekit');
    expect(c.voice.stunUrls).toEqual(['stun:stun.l.google.com:19302']);
    expect(c.voice.turnUrls).toEqual([]);
    expect(c.routing).toMatchObject({
      provider: 'valhalla',
      valhallaUrl: 'https://valhalla1.openstreetmap.de',
      osrmUrl: 'https://router.project-osrm.org',
      orsUrl: 'https://api.openrouteservice.org',
      orsApiKey: null,
    });
    expect(c.geocoder).toEqual({
      provider: 'photon',
      photonUrl: 'https://photon.komoot.io',
      nominatimUrl: 'https://nominatim.openstreetmap.org',
    });
    expect(c.providerTimeoutMs).toBe(8_000);
    expect(c.timing).toEqual({
      sweepIntervalMs: 30_000,
      leaderGraceMs: TIMING.leaderGraceMs,
      riderPruneMs: TIMING.riderPruneMs,
      rideIdleTtlMs: TIMING.rideIdleTtlMs,
      breakCooldownMs: TIMING.breakCooldownMs,
      recentBreakMs: TIMING.recentBreakMs,
    });
    expect(c.joinPerMinutePerIp).toBe(LIMITS.joinPerMinutePerIp);
    expect(DEFAULT_STATIC_DIR.endsWith(path.join('apps', 'web', 'dist'))).toBe(true);
  });

  it('treats blank values as unset', () => {
    const c = loadConfig({ PORT: '', TURN_URLS: '', LIVEKIT_URL: ' ', ROUTING_PROVIDER: '' });
    expect(c.port).toBe(8787);
    expect(c.routing.provider).toBe('valhalla');
    expect(c.voice.livekit).toBeNull();
  });

  it('reads every variable', () => {
    const c = loadConfig({
      NODE_ENV: 'production',
      PORT: '9000',
      HOST: '127.0.0.1',
      LOG_LEVEL: 'WARN',
      TRUST_PROXY: '1',
      STATIC_DIR: webDist,
      CORS_ORIGINS: 'capacitor://localhost, https://Example.com/ ,',
      MAX_RIDERS: '12',
      LIVEKIT_URL: 'wss://lk.example.com',
      LIVEKIT_API_KEY: 'key',
      LIVEKIT_API_SECRET: 'secret',
      DEFAULT_VOICE_MODE: 'mesh',
      STUN_URLS: 'stun:a.example:3478,stun:b.example:3478',
      TURN_URLS: 'turn:t.example:3478?transport=udp,turns:t.example:5349',
      TURN_SECRET: 'shh',
      ROUTING_PROVIDER: 'ors',
      ORS_API_KEY: 'ors-key',
      OSRM_URL: 'http://osrm.local:5000/',
      GEOCODER: 'nominatim',
      PROVIDER_TIMEOUT_MS: '2000',
      SWEEP_INTERVAL_MS: '50',
      LEADER_GRACE_MS: '1000',
      RIDER_PRUNE_MS: '2000',
      RIDE_IDLE_TTL_MS: '3000',
      BREAK_COOLDOWN_MS: '0',
      RECENT_BREAK_MS: '5000',
      JOIN_PER_MINUTE_PER_IP: '500',
    });
    expect(c).toMatchObject({
      production: true,
      port: 9000,
      host: '127.0.0.1',
      logLevel: 'warn',
      trustProxyHops: 1,
      staticDir: webDist,
      corsOrigins: ['capacitor://localhost', 'https://example.com'],
      maxRiders: 12,
      voice: {
        livekit: { url: 'wss://lk.example.com', apiKey: 'key', apiSecret: 'secret' },
        defaultMode: 'mesh',
        stunUrls: ['stun:a.example:3478', 'stun:b.example:3478'],
        turnUrls: ['turn:t.example:3478?transport=udp', 'turns:t.example:5349'],
        turnSecret: 'shh',
      },
      routing: { provider: 'ors', orsApiKey: 'ors-key', osrmUrl: 'http://osrm.local:5000' },
      geocoder: { provider: 'nominatim' },
      providerTimeoutMs: 2000,
      timing: {
        sweepIntervalMs: 50,
        leaderGraceMs: 1000,
        riderPruneMs: 2000,
        rideIdleTtlMs: 3000,
        breakCooldownMs: 0,
        recentBreakMs: 5000,
      },
      joinPerMinutePerIp: 500,
    });
  });

  it('enables LiveKit only when url, key and secret are all set', () => {
    expect(loadConfig({ LIVEKIT_URL: 'ws://127.0.0.1:7880', LIVEKIT_API_KEY: 'devkey' }).voice.livekit).toBeNull();
    const env = { LIVEKIT_URL: 'ws://127.0.0.1:7880', LIVEKIT_API_KEY: 'devkey' };
    expect(configWarnings(loadConfig(env), env)).toEqual([expect.stringContaining('LIVEKIT_API_SECRET')]);
  });

  it('understands TRUST_PROXY spellings', () => {
    expect(loadConfig({ TRUST_PROXY: 'true' }).trustProxyHops).toBe(1);
    expect(loadConfig({ TRUST_PROXY: 'false' }).trustProxyHops).toBe(0);
    expect(loadConfig({ TRUST_PROXY: '0' }).trustProxyHops).toBe(0);
    expect(loadConfig({ TRUST_PROXY: '2' }).trustProxyHops).toBe(2);
    expect(() => loadConfig({ TRUST_PROXY: 'sometimes' })).toThrow(ConfigError);
  });

  it('disables static serving when the directory has no index.html', () => {
    expect(loadConfig({ STATIC_DIR: path.join(webDist, 'missing') }).staticDir).toBeNull();
  });

  it('rejects invalid values with a readable message naming each variable', () => {
    let error: unknown;
    try {
      loadConfig({ PORT: 'eighty', ROUTING_PROVIDER: 'carrier-pigeon', STUN_URLS: 'http://x', MAX_RIDERS: '99' });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as Error).message;
    for (const key of ['PORT', 'ROUTING_PROVIDER', 'STUN_URLS', 'MAX_RIDERS']) expect(message).toContain(key);
  });

  it('requires an API key for openrouteservice', () => {
    expect(() => loadConfig({ ROUTING_PROVIDER: 'ors' })).toThrow(/ORS_API_KEY/);
  });

  it('warns about TURN settings that cannot work', () => {
    const urlsOnly = { TURN_URLS: 'turn:t.example:3478' };
    expect(configWarnings(loadConfig(urlsOnly), urlsOnly)[0]).toMatch(/TURN is disabled/);
    const credsOnly = { TURN_SECRET: 'x' };
    expect(configWarnings(loadConfig(credsOnly), credsOnly)[0]).toMatch(/TURN_URLS is empty/);
    expect(configWarnings(loadConfig({}), {})).toEqual([]);
  });
});

describe('normalizeOrigin', () => {
  it('reduces URLs to scheme://host[:port]', () => {
    expect(normalizeOrigin('https://Example.com/path')).toBe('https://example.com');
    expect(normalizeOrigin('http://localhost:80')).toBe('http://localhost');
    expect(normalizeOrigin('capacitor://localhost')).toBe('capacitor://localhost');
    expect(normalizeOrigin('nonsense')).toBeNull();
  });
});
