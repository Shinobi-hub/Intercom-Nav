/**
 * Multi-rider E2E suite. Every rider is its own Chromium process (the fake-microphone file is a
 * per-process flag), so tests launch browsers through helpers/rider.ts instead of using `page`.
 *
 *   npx playwright test -c e2e                         full suite (dev: ride server + Vite)
 *   npx playwright test -c e2e --grep @livekit         by tag: @slow, @livekit, @mesh
 *   E2E_SERVERS=0 npx playwright test -c e2e --project=harness   harness smoke only, no app needed
 *   E2E_PROD=1 npx playwright test -c e2e              against the production build served by the ride server
 *
 * More switches in helpers/env.ts.
 */
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';
import {
  APP_URL,
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET,
  LIVEKIT_WS_URL,
  PROD,
  REPO_ROOT,
  REUSE_SERVERS,
  SERVER_PORT,
  SERVER_URL,
  START_SERVERS,
  VITE_PORT,
  VITE_URL,
} from './helpers/env';

const rideServerEnv: Record<string, string> = {
  PORT: String(SERVER_PORT),
  HOST: '127.0.0.1',
  ROUTING_PROVIDER: 'mock',
  GEOCODER: 'mock',
  LIVEKIT_URL: LIVEKIT_WS_URL,
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET,
  DEFAULT_VOICE_MODE: 'livekit',
  // Every rider browser joins from 127.0.0.1; the default 20/min per IP would throttle the suite.
  JOIN_PER_MINUTE_PER_IP: '1000',
  // Riders open the app from these origins (Vite in dev, the server itself in production mode).
  CORS_ORIGINS: [VITE_URL, `http://localhost:${VITE_PORT}`, SERVER_URL, `http://localhost:${SERVER_PORT}`].join(','),
  NODE_ENV: PROD ? 'production' : 'development',
};

const rideServer = {
  name: 'ride-server',
  // Production mode rebuilds apps/web/dist, which the ride server serves.
  command: PROD ? 'npm run build -w @intercom/web && npx tsx apps/server/src/index.ts' : 'npx tsx apps/server/src/index.ts',
  cwd: REPO_ROOT,
  env: rideServerEnv,
  url: `${SERVER_URL}/api/health`,
  reuseExistingServer: REUSE_SERVERS,
  timeout: PROD ? 240_000 : 60_000,
  gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 5_000 },
};

const viteServer = {
  name: 'vite',
  // The app's vite.config.ts with HMR off (see vite.e2e.config.ts).
  command: `npx vite --config ../../e2e/vite.e2e.config.ts --host 127.0.0.1 --port ${VITE_PORT} --strictPort`,
  cwd: join(REPO_ROOT, 'apps', 'web'),
  env: { INTERCOM_SERVER_URL: SERVER_URL },
  url: VITE_URL,
  reuseExistingServer: REUSE_SERVERS,
  timeout: 60_000,
  gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 5_000 },
};

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  globalSetup: './global-setup.ts',
  // Riders are heavy (a browser each, real WebRTC, real audio timing): one test at a time.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL: APP_URL,
    actionTimeout: 15_000,
    navigationTimeout: 45_000,
  },
  webServer: START_SERVERS ? (PROD ? [rideServer] : [rideServer, viteServer]) : undefined,
  projects: [
    // Proves the rig itself (fixtures, fake mics, LiveKit, WebRTC between rider browsers); needs no app.
    { name: 'harness', testMatch: /harness\.[\w-]+\.spec\.ts$/ },
    { name: 'app', testIgnore: /harness\.[\w-]+\.spec\.ts$/ },
  ],
});
