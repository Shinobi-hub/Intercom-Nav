/**
 * Where everything lives and how the suite is configured. Read by playwright.config.ts, global setup
 * and the helpers, so a single env var flips a behaviour everywhere.
 *
 * Env switches:
 *   E2E_PROD=1          Build the web app and let the ride server serve it (debug hooks via ?debug=1).
 *   E2E_SERVERS=0       Don't start the ride server / Vite (harness-only runs).
 *   E2E_REUSE_SERVERS=1 Reuse servers already listening on the e2e ports instead of failing.
 *   E2E_HEADED=1        Show the rider browsers (audio is audible in headed mode).
 *   E2E_REAL_TILES=1    Let OpenFreeMap tiles through (default: a blank offline style, deterministic).
 *   E2E_REAL_TTS=1      Let the app speak through speechSynthesis (default: recorded, silent).
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const E2E_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = join(E2E_DIR, '..');
export const AUDIO_DIR = join(E2E_DIR, 'fixtures', 'audio');
export const SCREENSHOT_DIR = join(E2E_DIR, 'screenshots');

const flag = (name: string) => process.env[name] === '1' || process.env[name] === 'true';

export const PROD = flag('E2E_PROD');
export const START_SERVERS = process.env.E2E_SERVERS !== '0';
export const REUSE_SERVERS = flag('E2E_REUSE_SERVERS');
export const HEADED = flag('E2E_HEADED');
export const REAL_TILES = flag('E2E_REAL_TILES');
export const REAL_TTS = flag('E2E_REAL_TTS');

export const SERVER_PORT = 8790;
export const VITE_PORT = 5180;
export const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;
export const VITE_URL = `http://127.0.0.1:${VITE_PORT}`;
/** The origin riders open: Vite in dev, the ride server itself in production mode. */
export const APP_URL = PROD ? SERVER_URL : VITE_URL;

export const LIVEKIT_WS_URL = 'ws://127.0.0.1:7880';
export const LIVEKIT_HTTP_URL = 'http://127.0.0.1:7880';
export const LIVEKIT_API_KEY = 'devkey';
export const LIVEKIT_API_SECRET = 'secret';

/** Set by global setup: 'up' | 'down'. */
export const LIVEKIT_STATUS_ENV = 'E2E_LIVEKIT';

/** App URL for a path. Production builds only expose `window.__intercom` with ?debug=1. */
export function appUrl(path = '/'): string {
  const url = new URL(path, APP_URL);
  if (PROD) url.searchParams.set('debug', '1');
  return url.toString();
}

/** Plain HTTP reachability probe (LiveKit answers "OK" on /). */
export async function isReachable(url: string, timeoutMs = 3_000): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/** LiveKit state as determined by global setup, probing directly when setup didn't run. */
export async function livekitUp(): Promise<boolean> {
  const status = process.env[LIVEKIT_STATUS_ENV];
  if (status === 'up' || status === 'down') return status === 'up';
  const up = await isReachable(LIVEKIT_HTTP_URL);
  process.env[LIVEKIT_STATUS_ENV] = up ? 'up' : 'down';
  return up;
}

export const LIVEKIT_DOWN_MESSAGE =
  `LiveKit dev server not reachable at ${LIVEKIT_HTTP_URL}; @livekit tests are skipped. ` +
  'Start it with `npm run livekit:dev` (advertises the LAN IP; see scripts/livekit-dev.mjs).';
