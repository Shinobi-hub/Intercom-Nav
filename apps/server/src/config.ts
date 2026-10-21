import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITS, TIMING, type VoiceMode } from '@intercom/shared';
import { z } from 'zod';

/**
 * The server package directory. This module lives one level below it both as `src/config.ts`
 * (tsx, vitest) and inside the bundled `dist/index.js`, so `..` resolves the same either way.
 */
export const SERVER_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const REPO_ROOT = path.resolve(SERVER_ROOT, '../..');
export const DEFAULT_STATIC_DIR = path.resolve(SERVER_ROOT, '../web/dist');

export type RoutingProviderName = 'valhalla' | 'osrm' | 'ors' | 'mock';
export type GeocoderName = 'photon' | 'nominatim' | 'mock';
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface TimingConfig {
  sweepIntervalMs: number;
  leaderGraceMs: number;
  riderPruneMs: number;
  rideIdleTtlMs: number;
  breakCooldownMs: number;
  recentBreakMs: number;
}

export interface Config {
  production: boolean;
  port: number;
  host: string;
  logLevel: LogLevel;
  /** Proxy hops whose X-Forwarded-* headers are trusted (0 = ignore them). */
  trustProxyHops: number;
  /** Built web app to serve, or null when the directory has no index.html. */
  staticDir: string | null;
  /** Extra cross-origin callers (native app WebViews), normalized. */
  corsOrigins: string[];
  maxRiders: number;
  voice: {
    livekit: { url: string; apiKey: string; apiSecret: string } | null;
    defaultMode: VoiceMode;
    stunUrls: string[];
    turnUrls: string[];
    turnUsername: string | null;
    turnCredential: string | null;
    turnSecret: string | null;
  };
  routing: {
    provider: RoutingProviderName;
    valhallaUrl: string;
    osrmUrl: string;
    orsUrl: string;
    orsApiKey: string | null;
  };
  geocoder: {
    provider: GeocoderName;
    photonUrl: string;
    nominatimUrl: string;
  };
  /** Timeout for each routing / geocoding request. */
  providerTimeoutMs: number;
  timing: TimingConfig;
  joinPerMinutePerIp: number;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** .env files commonly carry `KEY=` lines; treat blank values as unset so defaults apply. */
const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const text = () => z.preprocess(blankToUndefined, z.string().trim().optional());
const httpUrl = (fallback: string) =>
  z.preprocess(
    blankToUndefined,
    z
      .url({ protocol: /^https?$/ })
      .default(fallback)
      .transform((u) => u.replace(/\/+$/, '')),
  );
const int = (fallback: number, min: number, max = Number.MAX_SAFE_INTEGER) =>
  z.preprocess(blankToUndefined, z.coerce.number().int().min(min).max(max).default(fallback));
const list = (fallback: string[], pattern?: RegExp, what = 'entry') =>
  z.preprocess(
    blankToUndefined,
    z
      .string()
      .optional()
      .transform((s) => (s === undefined ? fallback : s.split(',').map((x) => x.trim()).filter(Boolean)))
      .pipe(z.array(pattern ? z.string().regex(pattern, `invalid ${what}`) : z.string())),
  );
const enumOf = <const T extends readonly [string, ...string[]]>(values: T, fallback: T[number]) =>
  z.preprocess(
    (v) => (typeof blankToUndefined(v) === 'string' ? String(v).trim().toLowerCase() : undefined),
    z.enum(values).default(fallback),
  );

/** "1"/"true" trust the nearest proxy only; a larger integer trusts that many hops. */
const trustProxy = z.preprocess(
  blankToUndefined,
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      const s = (v ?? '0').trim().toLowerCase();
      if (['0', 'false', 'no', 'off'].includes(s)) return 0;
      if (['1', 'true', 'yes', 'on'].includes(s)) return 1;
      const n = Number(s);
      if (Number.isInteger(n) && n > 0 && n <= 10) return n;
      ctx.addIssue({ code: 'custom', message: 'expected 0/1/true/false or a hop count up to 10' });
      return z.NEVER;
    }),
);

const envSchema = z
  .object({
    NODE_ENV: text(),
    PORT: int(8787, 0, 65_535),
    HOST: text(),
    LOG_LEVEL: enumOf(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'], 'info'),
    TRUST_PROXY: trustProxy,
    STATIC_DIR: text(),
    CORS_ORIGINS: list([]),
    MAX_RIDERS: int(LIMITS.maxRidersDefault, 2, LIMITS.maxRidersCap),

    LIVEKIT_URL: z.preprocess(blankToUndefined, z.url({ protocol: /^(wss?|https?)$/ }).optional()),
    LIVEKIT_API_KEY: text(),
    LIVEKIT_API_SECRET: text(),
    DEFAULT_VOICE_MODE: enumOf(['livekit', 'mesh'], 'livekit'),
    STUN_URLS: list(['stun:stun.l.google.com:19302'], /^stuns?:\S+$/, 'STUN url'),
    TURN_URLS: list([], /^turns?:\S+$/, 'TURN url'),
    TURN_USERNAME: text(),
    TURN_CREDENTIAL: text(),
    TURN_SECRET: text(),

    ROUTING_PROVIDER: enumOf(['valhalla', 'osrm', 'ors', 'mock'], 'valhalla'),
    VALHALLA_URL: httpUrl('https://valhalla1.openstreetmap.de'),
    OSRM_URL: httpUrl('https://router.project-osrm.org'),
    ORS_URL: httpUrl('https://api.openrouteservice.org'),
    ORS_API_KEY: text(),
    GEOCODER: enumOf(['photon', 'nominatim', 'mock'], 'photon'),
    PHOTON_URL: httpUrl('https://photon.komoot.io'),
    NOMINATIM_URL: httpUrl('https://nominatim.openstreetmap.org'),
    PROVIDER_TIMEOUT_MS: int(8_000, 100, 60_000),

    // Timing overrides, mainly so tests can exercise expiry without waiting.
    SWEEP_INTERVAL_MS: int(30_000, 10),
    LEADER_GRACE_MS: int(TIMING.leaderGraceMs, 0),
    RIDER_PRUNE_MS: int(TIMING.riderPruneMs, 0),
    RIDE_IDLE_TTL_MS: int(TIMING.rideIdleTtlMs, 0),
    BREAK_COOLDOWN_MS: int(TIMING.breakCooldownMs, 0),
    RECENT_BREAK_MS: int(TIMING.recentBreakMs, 0),
    JOIN_PER_MINUTE_PER_IP: int(LIMITS.joinPerMinutePerIp, 1),
  })
  .superRefine((env, ctx) => {
    if (env.ROUTING_PROVIDER === 'ors' && !env.ORS_API_KEY) {
      ctx.addIssue({ code: 'custom', path: ['ORS_API_KEY'], message: 'required when ROUTING_PROVIDER=ors' });
    }
  });

type Env = Record<string, string | undefined>;

/** Accepts "https://a.example/", "capacitor://localhost" etc.; returns scheme://host[:port] or null. */
export function normalizeOrigin(origin: string): string | null {
  try {
    const u = new URL(origin.trim());
    if (!u.host) return null;
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return null;
  }
}

/** Parses the environment into a Config. Throws ConfigError listing every invalid variable. */
export function loadConfig(env: Env = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(`Invalid server configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const e = parsed.data;

  const staticDir = path.resolve(e.STATIC_DIR ?? DEFAULT_STATIC_DIR);
  const livekit =
    e.LIVEKIT_URL && e.LIVEKIT_API_KEY && e.LIVEKIT_API_SECRET
      ? { url: e.LIVEKIT_URL, apiKey: e.LIVEKIT_API_KEY, apiSecret: e.LIVEKIT_API_SECRET }
      : null;

  return {
    production: (e.NODE_ENV ?? '').toLowerCase() === 'production',
    port: e.PORT,
    host: e.HOST ?? '0.0.0.0',
    logLevel: e.LOG_LEVEL,
    trustProxyHops: e.TRUST_PROXY,
    staticDir: hasIndexHtml(staticDir) ? staticDir : null,
    corsOrigins: e.CORS_ORIGINS.map(normalizeOrigin).filter((o): o is string => o !== null),
    maxRiders: e.MAX_RIDERS,
    voice: {
      livekit,
      defaultMode: e.DEFAULT_VOICE_MODE,
      stunUrls: e.STUN_URLS,
      turnUrls: e.TURN_URLS,
      turnUsername: e.TURN_USERNAME ?? null,
      turnCredential: e.TURN_CREDENTIAL ?? null,
      turnSecret: e.TURN_SECRET ?? null,
    },
    routing: {
      provider: e.ROUTING_PROVIDER,
      valhallaUrl: e.VALHALLA_URL,
      osrmUrl: e.OSRM_URL,
      orsUrl: e.ORS_URL,
      orsApiKey: e.ORS_API_KEY ?? null,
    },
    geocoder: {
      provider: e.GEOCODER,
      photonUrl: e.PHOTON_URL,
      nominatimUrl: e.NOMINATIM_URL,
    },
    providerTimeoutMs: e.PROVIDER_TIMEOUT_MS,
    timing: {
      sweepIntervalMs: e.SWEEP_INTERVAL_MS,
      leaderGraceMs: e.LEADER_GRACE_MS,
      riderPruneMs: e.RIDER_PRUNE_MS,
      rideIdleTtlMs: e.RIDE_IDLE_TTL_MS,
      breakCooldownMs: e.BREAK_COOLDOWN_MS,
      recentBreakMs: e.RECENT_BREAK_MS,
    },
    joinPerMinutePerIp: e.JOIN_PER_MINUTE_PER_IP,
  };
}

/** Human-readable notes about settings that are accepted but probably not what was intended. */
export function configWarnings(config: Config, env: Env = process.env): string[] {
  const warnings: string[] = [];
  const set = (k: string) => (env[k] ?? '').trim() !== '';
  const lkKeys = ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'];
  if (!config.voice.livekit && lkKeys.some(set)) {
    warnings.push(`LiveKit is disabled: ${lkKeys.filter((k) => !set(k)).join(', ')} not set`);
  }
  const { turnUrls, turnUsername, turnCredential, turnSecret } = config.voice;
  const staticTurn = Boolean(turnUsername && turnCredential);
  if (turnUrls.length > 0 && !staticTurn && !turnSecret) {
    warnings.push('TURN_URLS is set without TURN_USERNAME/TURN_CREDENTIAL or TURN_SECRET; TURN is disabled');
  }
  if (turnUrls.length === 0 && (staticTurn || turnSecret)) {
    warnings.push('TURN credentials are set but TURN_URLS is empty; TURN is disabled');
  }
  if (staticTurn && turnSecret) {
    warnings.push('Both static TURN credentials and TURN_SECRET are set; using the static credentials');
  }
  if (Boolean(turnUsername) !== Boolean(turnCredential)) {
    warnings.push('TURN_USERNAME and TURN_CREDENTIAL must be set together');
  }
  return warnings;
}

function hasIndexHtml(dir: string): boolean {
  try {
    return statSync(path.join(dir, 'index.html')).isFile();
  } catch {
    return false;
  }
}
