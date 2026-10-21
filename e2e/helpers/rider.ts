/**
 * One simulated rider = one Chromium process (fake-mic file is a per-process flag) + one phone-sized
 * context with geolocation and microphone granted. Riders expose typed accessors for the app's
 * `window.__intercom` debug hooks; RiderPool closes every browser even when a test fails.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Locator, type Page, type TestInfo } from '@playwright/test';
import type { RiderId } from '@intercom/shared';
import { micFile, type FakeMic } from './audioFixtures';
import type { AppSnapshot, DebugSectionName, DebugSections, Settings } from './contract';
import { APP_URL, HEADED, REAL_TILES, REAL_TTS } from './env';
import { installPageHelpers, type ProbeName, type ProbeTypes } from './pageScript';

export interface LatLngAcc {
  lat: number;
  lng: number;
  /** Meters; defaults to 8. */
  accuracy?: number;
}

export interface LaunchRiderOptions {
  name: string;
  /** Fake microphone (looped WAV). Default 'silence': Chrome's built-in fake mic beeps. */
  audio?: FakeMic;
  /** Initial emulated geolocation (the real navigator.geolocation path). Default: Pune. */
  geo?: LatLngAcc;
  /** CSS pixels. Default 390x844 (portrait phone). */
  viewport?: { width: number; height: number };
  deviceScaleFactor?: number;
  /** Persisted app settings seeded before the app first loads (merged over the app's defaults). */
  settings?: Partial<Settings>;
}

export const PHONE_PORTRAIT = { width: 390, height: 844 } as const;
export const PHONE_LANDSCAPE = { width: 844, height: 390 } as const;
export const PUNE: LatLngAcc = { lat: 18.5204, lng: 73.8567 };

// ---- Chromium flags ---------------------------------------------------------------------------

const MDNS_FEATURE = 'WebRtcHideLocalIpsWithMdns';
let featureArgs: Promise<{ ignore: string[]; arg: string }> | null = null;

/**
 * Chromium only honours the last --disable-features switch, and Playwright passes its own list.
 * Appending ours would silently re-enable Playwright's (PaintHolding, ThirdPartyStoragePartitioning, ...),
 * so read Playwright's exact switch once and replace it with a merged one.
 */
function disableFeaturesArgs(): Promise<{ ignore: string[]; arg: string }> {
  featureArgs ??= (async () => {
    const server = await chromium.launchServer({ headless: true });
    try {
      const own = server.process().spawnargs.find((a) => a.startsWith('--disable-features='));
      if (!own) return { ignore: [], arg: `--disable-features=${MDNS_FEATURE}` };
      return { ignore: [own], arg: `${own},${MDNS_FEATURE}` };
    } finally {
      await server.close();
    }
  })();
  return featureArgs;
}

export async function riderLaunchArgs(audio: FakeMic): Promise<{ args: string[]; ignoreDefaultArgs: string[] }> {
  const features = await disableFeaturesArgs();
  return {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${micFile(audio)}`,
      '--autoplay-policy=no-user-gesture-required',
      // Real host candidates instead of mDNS names, so mesh peers and LiveKit connect locally.
      features.arg,
    ],
    ignoreDefaultArgs: features.ignore,
  };
}

// ---- offline map style ------------------------------------------------------------------------

/** Replaces OpenFreeMap with a blank dark style: deterministic, offline, cheap to render. */
const BLANK_STYLE = {
  version: 8,
  name: 'e2e-blank',
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#1d2329' } }],
};

async function routeMapTiles(context: BrowserContext): Promise<void> {
  await context.route(/^https:\/\/tiles\.openfreemap\.org\//, (route) => {
    const url = route.request().url();
    if (url.includes('/styles/')) return route.fulfill({ json: BLANK_STYLE });
    if (url.includes('/fonts/')) return route.fulfill({ status: 200, contentType: 'application/x-protobuf', body: '' });
    return route.fulfill({ status: 404, body: '' });
  });
}

// ---- debug accessors --------------------------------------------------------------------------

/** A debug section as seen from Node: every method returns a promise of its result. */
export type Remote<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
};

async function callDebug(page: Page, section: DebugSectionName, method: string, args: unknown[]): Promise<unknown> {
  return page.evaluate(
    async ({ section, method, args }) => {
      const g = window.__intercom;
      if (!g) {
        throw new Error('window.__intercom is missing: debug hooks are off (they need the dev server, ?debug=1 or localStorage intercom:debug=1)');
      }
      const s = g[section] as Record<string, unknown> | undefined;
      if (!s) throw new Error(`window.__intercom.${section} is not registered (the feature must call registerDebug('${section}', ...))`);
      const fn = s[method];
      if (typeof fn !== 'function') throw new Error(`window.__intercom.${section}.${method} is not a function`);
      return await (fn as (...a: unknown[]) => unknown).apply(s, args);
    },
    { section, method, args },
  );
}

function remoteSection<K extends DebugSectionName>(rider: Rider, section: K): Remote<DebugSections[K]> {
  return new Proxy({} as Remote<DebugSections[K]>, {
    get(_target, method) {
      if (typeof method !== 'string' || method === 'then') return undefined;
      return (...args: unknown[]) => rider.guard(callDebug(rider.page, section, method, args));
    },
  });
}

// ---- rider ------------------------------------------------------------------------------------

export class Rider {
  readonly audio: Remote<DebugSections['audio']>;
  readonly voice: Remote<DebugSections['voice']>;
  readonly geo: Remote<DebugSections['geo']>;
  readonly map: Remote<DebugSections['map']>;
  private readonly log: string[] = [];
  private cachedId: RiderId | null = null;
  private samplerSeq = 0;

  constructor(
    readonly name: string,
    readonly mic: FakeMic,
    readonly browser: Browser,
    readonly context: BrowserContext,
    readonly page: Page,
  ) {
    this.audio = remoteSection(this, 'audio');
    this.voice = remoteSection(this, 'voice');
    this.geo = remoteSection(this, 'geo');
    this.map = remoteSection(this, 'map');
    const stamp = () => new Date().toISOString().slice(11, 23);
    page.on('console', (m) => this.pushLog(`${stamp()} ${m.type()}: ${m.text()}`));
    page.on('pageerror', (e) => this.pushLog(`${stamp()} pageerror: ${e.message}`));
    page.on('crash', () => this.pushLog(`${stamp()} page crashed`));
  }

  private pushLog(line: string): void {
    this.log.push(line);
    if (this.log.length > 600) this.log.splice(0, this.log.length - 600);
  }

  /** Prefixes errors with the rider's name: with four browsers, "which one?" matters. */
  async guard<T>(p: Promise<T>): Promise<T> {
    try {
      return await p;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`[${this.name}] ${msg}`);
    }
  }

  tid(testId: string): Locator {
    return this.page.getByTestId(testId);
  }

  /** Typed `window.__intercom.state()`. */
  state(): Promise<AppSnapshot> {
    return this.guard(
      this.page.evaluate(() => {
        const g = window.__intercom;
        if (!g) throw new Error('window.__intercom is missing: debug hooks are off');
        return g.state() as unknown;
      }) as Promise<AppSnapshot>,
    );
  }

  /** This rider's id (from the ride store; available once in a ride). */
  async id(): Promise<RiderId> {
    if (this.cachedId) return this.cachedId;
    const { ride } = await this.state();
    if (!ride.selfId) throw new Error(`[${this.name}] has no rider id yet (not in a ride)`);
    this.cachedId = ride.selfId;
    return ride.selfId;
  }

  /** Texts the app passed to speechSynthesis.speak (recorded, not spoken). */
  spoken(): Promise<string[]> {
    return this.guard(this.page.evaluate(() => window.__e2e?.spoken.slice() ?? []));
  }

  /** Starts an in-page sampler; see pageScript.ts for the probes. */
  async startSampler<P extends ProbeName>(probe: P, arg: ProbeTypes[P]['arg'], intervalMs: number): Promise<Sampler<ProbeTypes[P]['sample']>> {
    const key = `${probe}-${++this.samplerSeq}`;
    await this.guard(
      this.page.evaluate(({ key, probe, arg, intervalMs }) => window.__e2e!.startSampler(key, probe, arg, intervalMs), {
        key,
        probe,
        arg,
        intervalMs,
      }),
    );
    return new Sampler(this, key);
  }

  consoleTail(lines = 200): string {
    return this.log.slice(-lines).join('\n');
  }

  /** Screenshot + store snapshot + console tail, attached to the test report. */
  async attachDiagnostics(testInfo: TestInfo): Promise<void> {
    const label = this.name.toLowerCase().replace(/\W+/g, '-');
    try {
      await testInfo.attach(`${label}-screen.png`, { body: await this.page.screenshot({ timeout: 5_000 }), contentType: 'image/png' });
    } catch {
      /* page may be gone */
    }
    try {
      const state = await this.page.evaluate(() => window.__intercom?.state() ?? null);
      await testInfo.attach(`${label}-state.json`, { body: JSON.stringify(state, null, 2), contentType: 'application/json' });
    } catch {
      /* page may be gone */
    }
    await testInfo.attach(`${label}-console.txt`, { body: this.consoleTail() || '(no console output)', contentType: 'text/plain' });
  }

  async close(): Promise<void> {
    await this.browser.close().catch(() => {});
  }
}

/** Handle to an in-page sampler; pull() fetches only new samples. */
export class Sampler<S> {
  private readonly all: S[] = [];
  private errors: string[] = [];

  constructor(
    private readonly rider: Rider,
    private readonly key: string,
  ) {}

  async pull(): Promise<S[]> {
    const { samples, errors } = await this.rider.guard(
      this.rider.page.evaluate(
        ({ key, from }) => {
          const s = window.__e2e?.samplers[key];
          return { samples: (s?.samples.slice(from) ?? []) as unknown[], errors: s?.errors ?? [] };
        },
        { key: this.key, from: this.all.length },
      ),
    );
    this.all.push(...(samples as S[]));
    this.errors = errors;
    if (this.all.length === 0 && this.errors.length) {
      throw new Error(`[${this.rider.name}] sampler ${this.key} failed: ${this.errors[0]}`);
    }
    return this.all;
  }

  get samples(): readonly S[] {
    return this.all;
  }

  async stop(): Promise<S[]> {
    const all = await this.pull();
    await this.rider.page.evaluate((key) => window.__e2e?.stopSampler(key), this.key).catch(() => {});
    return all;
  }
}

/** Launches a rider browser. Prefer RiderPool.launch (it guarantees cleanup). */
export async function launchRider(opts: LaunchRiderOptions): Promise<Rider> {
  const audio = opts.audio ?? 'silence';
  const geo = opts.geo ?? PUNE;
  const { args, ignoreDefaultArgs } = await riderLaunchArgs(audio);
  const browser = await chromium.launch({ headless: !HEADED, args, ignoreDefaultArgs });
  try {
    const context = await browser.newContext({
      baseURL: APP_URL,
      viewport: opts.viewport ?? PHONE_PORTRAIT,
      deviceScaleFactor: opts.deviceScaleFactor ?? 1,
      isMobile: true,
      hasTouch: true,
      locale: 'en-IN',
      timezoneId: 'Asia/Kolkata',
      geolocation: { latitude: geo.lat, longitude: geo.lng, accuracy: geo.accuracy ?? 8 },
      permissions: ['geolocation', 'microphone'],
    });
    await context.addInitScript(installPageHelpers, { settings: opts.settings ?? null, recordSpeech: !REAL_TTS });
    if (!REAL_TILES) await routeMapTiles(context);
    const page = await context.newPage();
    return new Rider(opts.name, audio, browser, context, page);
  } catch (e) {
    await browser.close().catch(() => {});
    throw e;
  }
}

/** Owns a test's riders: launches them, and on teardown attaches diagnostics (on failure) and closes all. */
export class RiderPool {
  private readonly riders: Rider[] = [];

  async launch(opts: LaunchRiderOptions): Promise<Rider> {
    const rider = await launchRider(opts);
    this.riders.push(rider);
    return rider;
  }

  /** Launches riders in parallel (each is its own browser); resolves to a tuple matching `list`. */
  launchAll<const T extends readonly LaunchRiderOptions[]>(list: T): Promise<{ -readonly [K in keyof T]: Rider }> {
    return Promise.all(list.map((o) => this.launch(o))) as Promise<{ -readonly [K in keyof T]: Rider }>;
  }

  get all(): readonly Rider[] {
    return this.riders;
  }

  async dispose(testInfo: TestInfo): Promise<void> {
    const failed = testInfo.status !== testInfo.expectedStatus;
    if (failed) await Promise.allSettled(this.riders.map((r) => r.attachDiagnostics(testInfo)));
    await Promise.allSettled(this.riders.map((r) => r.close()));
    this.riders.length = 0;
  }
}

/** Saves a PNG under e2e/screenshots and attaches it to the report. */
export async function saveScreenshot(rider: Rider, dir: string, name: string, testInfo?: TestInfo): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.png`);
  const body = await rider.page.screenshot({ animations: 'disabled', caret: 'hide' });
  writeFileSync(path, body);
  await testInfo?.attach(name, { body, contentType: 'image/png' });
  return path;
}
