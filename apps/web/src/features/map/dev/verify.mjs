// One-pass visual + behavioral check of the map harness. Needs `npx vite --port 5175` in apps/web.
// Run from the repo root: node apps/web/src/features/map/dev/verify.mjs
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.HARNESS_URL ?? 'http://localhost:5175/map-dev.html';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'screenshots');
const ROHAN = '0a0a0a0a-0000-4000-8000-000000000003';
mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

async function open(viewport, query = '', setup) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  if (setup) await setup(page);
  await page.goto(`${BASE}${query}`);
  await page.waitForFunction(() => window.__intercom?.map?.ready(), null, { timeout: 20_000 });
  return page;
}

const markers = (page) => page.evaluate(() => window.__intercom.map.markers());

// 1. Portrait, follow mode: markers present, glide between fixes.
{
  const page = await open({ width: 390, height: 844 });
  await page.waitForTimeout(6_000);
  const m = await markers(page);
  check('markers for self + 5 riders', Object.keys(m).length === 6, `${Object.keys(m).length} markers`);
  check('route visible', await page.evaluate(() => window.__intercom.map.routeVisible()));
  const sos = await page.locator('[data-sos="true"]').count();
  check('SOS marker flagged', sos === 1);

  // Sample a moving rider at 10 Hz for 3 s: fixes arrive every 0.8-2.5 s, so many distinct,
  // steadily advancing positions prove interpolation rather than jumps.
  const samples = [];
  for (let i = 0; i < 30; i++) {
    samples.push((await markers(page))[ROHAN]);
    await page.waitForTimeout(100);
  }
  const distinct = new Set(samples.map((s) => `${s.lat.toFixed(7)},${s.lng.toFixed(7)}`)).size;
  const steps = samples.slice(1).map((s, i) => Math.hypot(s.lat - samples[i].lat, s.lng - samples[i].lng) * 111_195);
  const maxStep = Math.max(...steps);
  check('marker glides (many intermediate positions)', distinct >= 20, `${distinct}/30 distinct, max step ${maxStep.toFixed(1)} m per 100 ms`);
  check('no jumps between samples', maxStep < 6, `rider at 16.5 m/s moves ~1.7 m per 100 ms`);
  await page.screenshot({ path: join(OUT, 'portrait-follow.png') });

  // 2. Camera: group fits everyone live; a drag switches to free and shows recenter.
  await page.getByTestId('map-camera-toggle').click();
  await page.waitForTimeout(2_000);
  const mode = await page.evaluate(() => window.__intercom.map.cameraMode());
  const inView = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="rider-marker-"][data-state="live"]')].every((el) => {
      const r = el.getBoundingClientRect();
      return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
    }),
  );
  check('group mode fits all live riders in view', mode === 'group' && inView, mode);
  await page.screenshot({ path: join(OUT, 'portrait-group.png') });
  await page.mouse.move(200, 400);
  await page.mouse.down();
  await page.mouse.move(120, 300, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const free = await page.evaluate(() => window.__intercom.map.cameraMode());
  check('drag enters free mode with recenter button', free === 'free' && (await page.getByTestId('map-recenter').isVisible()), free);
  await page.getByTestId('map-recenter').click();
  check('recenter returns to group', (await page.evaluate(() => window.__intercom.map.cameraMode())) === 'group');
  await page.close();
}

// 3. Landscape, group view.
{
  const page = await open({ width: 844, height: 390 }, '?camera=group');
  await page.waitForTimeout(5_000);
  await page.screenshot({ path: join(OUT, 'landscape-group.png') });
  await page.close();
}

// 4. Night theme via the canvas filter.
{
  const page = await open({ width: 390, height: 844 }, '?theme=night');
  await page.waitForTimeout(5_000);
  const filter = await page.evaluate(() => getComputedStyle(document.querySelector('.maplibregl-canvas')).filter);
  const markerFilter = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid^="rider-marker-"]')).filter);
  check('night filters the canvas only', filter.includes('invert') && markerFilter === 'none', filter);
  await page.screenshot({ path: join(OUT, 'portrait-night.png') });
  await page.close();
}

// 5. Offline: the style can't load, so the inline fallback takes over; markers and route still work.
{
  const page = await open({ width: 390, height: 844 }, '', (p) => p.route(/openfreemap\.org/, (r) => r.abort()));
  await page.waitForTimeout(4_000);
  const style = await page.getByTestId('map').getAttribute('data-style');
  const m = await markers(page);
  const routeVisible = await page.evaluate(() => window.__intercom.map.routeVisible());
  check('offline fallback style with markers and route', style === 'fallback' && Object.keys(m).length === 6 && routeVisible, style);
  await page.screenshot({ path: join(OUT, 'portrait-offline.png') });
  await page.close();
}

// 6. Route sheet (leader view with search results).
{
  const page = await open({ width: 390, height: 844 }, '?sheet=route');
  await page.getByTestId('dest-search-input').fill('lo');
  await page.getByTestId('dest-result-0').waitFor({ timeout: 5_000 });
  check('destination search shows results', true);
  await page.screenshot({ path: join(OUT, 'portrait-route-sheet.png') });
  await page.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
