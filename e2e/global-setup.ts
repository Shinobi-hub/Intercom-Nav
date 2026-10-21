/**
 * Runs once, after the web servers are up:
 *  1. Generates (when missing or outdated) and verifies the audio fixtures.
 *  2. Probes LiveKit; when it's down, @livekit tests skip with a clear message (see helpers/test.ts).
 *  3. Loads the app once so Vite has optimized its dependencies before four riders hit it at once
 *     (a mid-test "new dependencies optimized, reloading" would wipe a rider's state).
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import {
  appUrl,
  E2E_DIR,
  isReachable,
  LIVEKIT_DOWN_MESSAGE,
  LIVEKIT_HTTP_URL,
  LIVEKIT_STATUS_ENV,
  LIVEKIT_WS_URL,
  START_SERVERS,
} from './helpers/env';

function ensureAudioFixtures(): void {
  const script = join(E2E_DIR, 'fixtures', 'generate.mjs');
  const res = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`audio fixture generation failed (node ${script}):\n${res.stderr || res.stdout}`);
  }
  const summary = res.stdout.trim().split('\n').pop();
  console.log(`[e2e] ${summary}`);
}

async function probeLiveKit(): Promise<void> {
  const up = await isReachable(LIVEKIT_HTTP_URL);
  process.env[LIVEKIT_STATUS_ENV] = up ? 'up' : 'down';
  console.log(up ? `[e2e] LiveKit reachable at ${LIVEKIT_WS_URL}` : `[e2e] WARNING: ${LIVEKIT_DOWN_MESSAGE}`);
}

async function warmUpApp(): Promise<void> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(appUrl('/'), { waitUntil: 'load', timeout: 60_000 });
    await page.waitForFunction(() => (document.getElementById('root')?.childElementCount ?? 0) > 0, null, {
      timeout: 30_000,
    });
  } catch (e) {
    // Not fatal: tests will report what's actually wrong with the app.
    console.log(`[e2e] WARNING: app warm-up failed: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
  } finally {
    await browser.close();
  }
}

export default async function globalSetup(): Promise<void> {
  ensureAudioFixtures();
  await probeLiveKit();
  if (START_SERVERS) await warmUpApp();
}
