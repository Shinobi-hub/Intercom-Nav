/**
 * Debug-only diagnostics for the platform layer, exposed as `window.__intercomPlatform` when
 * DEBUG_ENABLED (dev, ?debug=1, or localStorage intercom:debug=1). It proves on a device or emulator
 * that GPS fixes and JS timers keep arriving with the screen off: every fix and a periodic tick are
 * logged to the console, which Capacitor forwards to logcat (tag "Capacitor/Console"), and
 * report() summarises them, including the longest gap between ticks.
 *
 * Don't run it during a real ride: it drives the same GeoProvider the location service uses.
 */
import type { GeoError, PlatformApi, RawFix } from '../core/services';

export interface ProbeReport {
  running: boolean;
  startedAt: number | null;
  fixes: number;
  lastFix: RawFix | null;
  lastFixAt: number | null;
  errors: GeoError[];
  ticks: number;
  lastTickAt: number | null;
  /** Longest gap between two ticks; ≫ tickMs means JS was frozen or throttled. */
  maxTickGapMs: number;
  visibility: DocumentVisibilityState;
  foreground: boolean;
  log: string[];
}

export interface PlatformProbe {
  readonly platform: PlatformApi;
  start(options?: { background?: boolean; tickMs?: number }): Promise<void>;
  stop(): Promise<void>;
  report(): ProbeReport;
}

declare global {
  interface Window {
    __intercomPlatform?: PlatformProbe;
  }
}

const LOG_LIMIT = 200;

export function createPlatformProbe(platform: PlatformApi): PlatformProbe {
  let running = false;
  let startedAt: number | null = null;
  let fixes = 0;
  let lastFix: RawFix | null = null;
  let lastFixAt: number | null = null;
  let errors: GeoError[] = [];
  let ticks = 0;
  let lastTickAt: number | null = null;
  let maxTickGapMs = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const log: string[] = [];

  const state = () =>
    `vis=${document.visibilityState} fg=${platform.lifecycle.isForeground()} online=${platform.network.isOnline()}`;
  const record = (line: string): void => {
    const entry = `${new Date().toISOString()} ${line}`;
    log.push(entry);
    if (log.length > LOG_LIMIT) log.shift();
    console.info(`[probe] ${line}`);
  };

  platform.lifecycle.onPause(() => record(`lifecycle pause ${state()}`));
  platform.lifecycle.onResume(() => record(`lifecycle resume ${state()}`));
  platform.network.onChange((online) => record(`network online=${online}`));
  document.addEventListener('visibilitychange', () => record(`visibilitychange ${state()}`));

  return {
    platform,

    async start({ background = true, tickMs = 5_000 } = {}) {
      if (running) return;
      running = true;
      startedAt = Date.now();
      fixes = 0;
      lastFix = null;
      lastFixAt = null;
      errors = [];
      ticks = 0;
      lastTickAt = Date.now();
      maxTickGapMs = 0;
      record(`start background=${background} ${state()}`);

      timer = setInterval(() => {
        const now = Date.now();
        const gap = lastTickAt === null ? 0 : now - lastTickAt;
        lastTickAt = now;
        maxTickGapMs = Math.max(maxTickGapMs, gap);
        ticks++;
        record(`tick #${ticks} gap=${gap}ms fixes=${fixes} ${state()}`);
      }, tickMs);

      if (background) {
        await platform.background
          .start({ title: 'Probe running', text: 'Platform probe · location on' })
          .catch((err: unknown) => record(`background.start failed: ${String(err)}`));
      }
      await platform.geo.start(
        (fix) => {
          fixes++;
          lastFix = fix;
          lastFixAt = Date.now();
          record(
            `fix #${fixes} ${fix.lat.toFixed(6)},${fix.lng.toFixed(6)} acc=${Math.round(fix.accuracy)} ` +
              `age=${lastFixAt - fix.timestamp}ms ${state()}`,
          );
        },
        (err) => {
          errors.push(err);
          record(`geo error ${err.code}: ${err.message}`);
        },
      );
    },

    async stop() {
      if (!running) return;
      running = false;
      if (timer !== null) clearInterval(timer);
      timer = null;
      await platform.geo.stop();
      await platform.background.stop().catch((err: unknown) => record(`background.stop failed: ${String(err)}`));
      record('stop');
    },

    report() {
      return {
        running,
        startedAt,
        fixes,
        lastFix,
        lastFixAt,
        errors: [...errors],
        ticks,
        lastTickAt,
        maxTickGapMs,
        visibility: document.visibilityState,
        foreground: platform.lifecycle.isForeground(),
        log: [...log],
      };
    },
  };
}
