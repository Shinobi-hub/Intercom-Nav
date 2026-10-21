#!/usr/bin/env node
/**
 * Screenshots every screen and state in demo mode at phone sizes, and audits touch targets:
 * every interactive element must be at least 56 px in both directions, the dock's four primary
 * keys at least 76 px.
 *
 *   npx vite --port 5174            (in apps/web, in another terminal)
 *   node apps/web/scripts/screenshots.mjs [--base URL] [--out DIR] [--only a,b] [--viewports 390x844,844x390]
 *
 * Exits 1 when the audit finds a violation in the app's own UI. Anything inside the map container
 * (markers, MapLibre's attribution) is reported separately: it belongs to the map feature.
 */
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, all) => {
    if (arg.startsWith('--')) acc.push([arg.slice(2), all[i + 1]?.startsWith('--') ? 'true' : (all[i + 1] ?? 'true')]);
    return acc;
  }, []),
);
const BASE = args.base ?? 'http://localhost:5174';
const OUT = resolve(args.out ?? join(here, '../src/dev/screenshots'));
const ONLY = args.only ? new Set(args.only.split(',')) : null;
const VIEWPORTS = (args.viewports ?? '390x844,844x390,360x780').split(',').map((v) => {
  const [width, height] = v.split('x').map(Number);
  return { name: v, width, height };
});

const SETTINGS = {
  state: { name: 'Aarav', color: '#0A84FF', units: 'metric', micMode: 'vox', liveMicMode: 'vox' },
  version: 1,
};

const tid = (id) => `[data-testid="${id}"]`;

async function openMenu(page, item) {
  await page.click(tid('dock-more'));
  await page.click(tid(`menu-${item}`));
  await page.waitForSelector(tid(`sheet-${item}`));
}

async function longPress(page, selector, ms) {
  const box = await page.locator(selector).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

/** name -> { url, seed?, run?(page), animations? } */
const SCENARIOS = {
  'home-first-run': { url: '/?demo=home', seed: false },
  home: { url: '/?demo=home' },
  'home-rejoin': { url: '/?demo=home,rejoin' },
  'home-error': {
    url: '/?demo=home',
    run: async (page) => {
      await page.fill(tid('home-join-code'), 'zzb-c23');
      await page.click(tid('home-join-submit'));
      await page.waitForSelector(tid('join-error'));
    },
  },
  join: { url: '/r/ABCD23?demo=home' },
  ride: { url: '/?demo=talking' },
  'ride-quiet-rider': { url: '/?demo=quiet,rider,nomusic' },
  'more-menu': { url: '/?demo=quiet', run: (page) => page.click(tid('dock-more')) },
  'sheet-route': { url: '/?demo=quiet', run: (page) => openMenu(page, 'route') },
  'sheet-riders': { url: '/?demo=talking', run: (page) => openMenu(page, 'riders') },
  'sheet-music': { url: '/?demo=quiet', run: (page) => openMenu(page, 'music') },
  'sheet-settings': { url: '/?demo=quiet', run: (page) => openMenu(page, 'settings') },
  'sheet-share': { url: '/?demo=quiet', run: (page) => openMenu(page, 'share') },
  'sheet-break': {
    url: '/?demo=quiet',
    run: async (page) => {
      await longPress(page, tid('dock-break'), 800);
      await page.waitForSelector(tid('sheet-break'));
    },
  },
  'break-sent': {
    url: '/?demo=quiet',
    run: async (page) => {
      await page.click(tid('dock-break'));
      await page.waitForSelector(`${tid('dock-break')}[data-state="sent"]`);
    },
  },
  'mic-muted': {
    url: '/?demo=quiet',
    run: async (page) => {
      await page.click(tid('dock-mic'));
      await page.waitForSelector(`${tid('dock-mic')}[data-mode="off"]`);
    },
  },
  'sos-holding': {
    url: '/?demo=quiet',
    animations: 'allow',
    run: async (page) => {
      const box = await page.locator(tid('dock-sos')).boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(900);
      return () => page.mouse.up();
    },
  },
  'sos-overlay': { url: '/?demo=sos,quiet', run: (page) => page.waitForSelector(tid('sos-overlay')) },
  'sos-banner': {
    url: '/?demo=sos,quiet',
    run: async (page) => {
      await page.click(tid('sos-silence'));
      await page.waitForSelector(tid('sos-banner'));
    },
  },
  'sos-own': { url: '/?demo=ownsos,quiet', run: (page) => page.waitForSelector(tid('sos-active-banner')) },
  toasts: { url: '/?demo=toasts,quiet', run: (page) => page.waitForSelector(tid('toast')) },
  resume: { url: '/?demo=resume,quiet', run: (page) => page.waitForSelector(tid('resume-audio')) },
  replaced: { url: '/?demo=replaced,quiet', run: (page) => page.waitForSelector(tid('session-replaced')) },
};

/** Runs in the page: every visible interactive element that is smaller than allowed. */
function auditTargets() {
  const PRIMARY = new Set(['dock-mic', 'dock-music', 'dock-break', 'dock-sos']);
  const selector =
    'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="switch"], [role="radio"], [role="menuitem"], [tabindex]:not([tabindex="-1"])';
  const out = [];
  for (const el of document.querySelectorAll(selector)) {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (r.width === 0 || r.height === 0 || style.visibility === 'hidden' || style.display === 'none') continue;
    // Screen-reader-only controls (e.g. a file input behind a styled button) aren't touch targets.
    if (r.width <= 2 && r.height <= 2) continue;
    if (el.closest('[aria-hidden="true"]')) continue;
    const id = el.getAttribute('data-testid');
    const min = id && PRIMARY.has(id) ? 76 : 56;
    const tolerance = 0.5;
    if (r.width + tolerance >= min && r.height + tolerance >= min) continue;
    const label =
      id ?? el.getAttribute('aria-label') ?? (el.textContent || '').trim().slice(0, 40) ?? el.tagName.toLowerCase();
    out.push({
      label,
      tag: el.tagName.toLowerCase(),
      size: `${Math.round(r.width)}x${Math.round(r.height)}`,
      min,
      // Markers and MapLibre's own controls live inside the map container: the map feature's call.
      mapControl: Boolean(el.closest('[data-testid="map"]')),
    });
  }
  return out;
}

const browser = await chromium.launch();
const violations = [];
const mapViolations = new Set();
let shots = 0;

try {
  for (const vp of VIEWPORTS) {
    await mkdir(join(OUT, vp.name), { recursive: true });
    for (const [name, scenario] of Object.entries(SCENARIOS)) {
      if (ONLY && !ONLY.has(name)) continue;
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 2,
        hasTouch: false,
        reducedMotion: 'no-preference',
        colorScheme: 'dark',
      });
      if (scenario.seed !== false) {
        await context.addInitScript((settings) => {
          window.localStorage.setItem('intercom:settings', JSON.stringify(settings));
        }, SETTINGS);
      }
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(BASE + scenario.url, { waitUntil: 'load' });
      // Give map tiles and entry animations a moment.
      await page.waitForTimeout(1_600);
      const finish = scenario.run ? await scenario.run(page) : null;
      await page.waitForTimeout(scenario.animations === 'allow' ? 0 : 350);
      const file = join(OUT, vp.name, `${name}.png`);
      await page.screenshot({ path: file, animations: scenario.animations ?? 'disabled' });
      shots++;
      if (typeof finish === 'function') await finish();
      for (const v of await page.evaluate(auditTargets)) {
        if (v.mapControl) mapViolations.add(`${v.label} ${v.size}`);
        else violations.push({ viewport: vp.name, scenario: name, ...v });
      }
      if (errors.length) console.log(`  ! ${vp.name} ${name}: page errors: ${errors.join(' | ')}`);
      await context.close();
      console.log(`  ✓ ${vp.name.padEnd(8)} ${name}`);
    }
  }
} finally {
  await browser.close();
}

console.log(`\n${shots} screenshots in ${OUT}`);
if (mapViolations.size) console.log(`Inside the map (map feature) under 56 px: ${[...mapViolations].join(', ')}`);
if (violations.length === 0) {
  console.log('Touch-target audit: every interactive element ≥ 56 px, dock keys ≥ 76 px.');
} else {
  console.log(`Touch-target audit: ${violations.length} violation(s)`);
  for (const v of violations) console.log(`  ${v.viewport} ${v.scenario}: ${v.tag} "${v.label}" ${v.size} (min ${v.min})`);
  process.exitCode = 1;
}
