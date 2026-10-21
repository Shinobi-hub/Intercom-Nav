#!/usr/bin/env node
/**
 * Screen-off check on the Android emulator (docs/NATIVE.md). A desktop Chromium rider creates a ride,
 * the debug app on the emulator joins it (driven over the WebView's DevTools socket), then the
 * emulator's screen is switched off while `adb emu geo fix` keeps moving it. Passes when, for the whole
 * screen-off window, the desktop keeps getting the emulator rider's new positions (its marker never
 * goes stale), both riders stay connected, and voice keeps flowing both ways.
 *
 * Needs (see docs/NATIVE.md): a ride server on :8791 whose LIVEKIT_URL the emulator can reach, a
 * front end for the desktop rider proxying to it (DESKTOP_URL), LiveKit, and the emulator running the
 * debug APK with its permissions granted.
 *
 *   DESKTOP_URL=http://127.0.0.1:5181/ node scripts/android-screen-off-check.mjs [screenOffSeconds=150]
 *
 * Like a real phone, the device must lock when the screen goes off: only then is the activity stopped
 * and the WebView window hidden, which is when a WebView that takes page visibility from its window
 * hides and later freezes the page. Emulator images ship with the lock screen disabled (the activity
 * would stay resumed), so the check enables it for the run.
 *
 * SILENT=1: nobody talks. Chromium never freezes an audible page, so a quiet ride is the hard case.
 * DOZE=1 also forces the device into deep Doze once the screen is off (battery unplugged first, both
 * restored at the end): the ride service's process must keep its network.
 * NO_KEEPALIVE=1 is the negative control: it restarts the ride service without the WebView keep-alive
 * before the screen goes off. A WebView that freezes background pages should then FAIL the check;
 * WebView 124 on the API 35 emulator never hid the page and kept passing (docs/NATIVE.md).
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { _android as android, chromium } from '@playwright/test';

const SDK = process.env.ANDROID_HOME ?? `${process.env.HOME}/Library/Android/sdk`;
const ADB = process.env.ADB ?? `${SDK}/platform-tools/adb`;
const DESKTOP_URL = process.env.DESKTOP_URL ?? 'http://127.0.0.1:5181/';
const SCREEN_OFF_S = Number(process.argv[2] ?? 150);
const DOZE = process.env.DOZE === '1';
const NO_KEEPALIVE = process.env.NO_KEEPALIVE === '1';
const PKG = 'app.intercomnav';
const SILENT = process.env.SILENT === '1';
const MIC = fileURLToPath(new URL(`../e2e/fixtures/audio/${SILENT ? 'silence' : 'speech-loop'}.wav`, import.meta.url));
const DESK_AT = { lat: 18.5204, lng: 73.8567 };
const STEP_M = 20; // the emulator rider moves 20 m north every 2 s (36 km/h)
const STALE_MS = 15_000; // TIMING.riderStaleMs

const adb = (...args) => execFileSync(ADB, args, { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const tid = (page, id) => page.locator(`[data-testid="${id}"]`);
const emuAt = (step) => ({ lat: DESK_AT.lat + 0.002 + (step * STEP_M) / 111_320, lng: DESK_AT.lng + 0.002 });
const geoFix = (p) => adb('emu', 'geo', 'fix', p.lng.toFixed(6), p.lat.toFixed(6));
const withTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => Promise.reject(new Error(`no answer within ${ms} ms`)))]);

async function waitFor(fn, message, timeout = 30_000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${message}`);
    await sleep(500);
  }
}

/** What a page knows about the ride, through the debug hooks. */
const readState = (page, peerId) =>
  page.evaluate(async (id) => {
    const g = window.__intercom;
    const { ride } = g.state();
    const stats = await g.voice.stats();
    return {
      selfId: ride.selfId,
      connection: ride.connection,
      riders: Object.keys(ride.riders).length,
      peer: id ? { online: ride.riders[id]?.online ?? null, t: ride.riders[id]?.location?.t ?? null, lat: ride.riders[id]?.location?.lat ?? null } : null,
      marker: id ? (g.map.markers()[id]?.state ?? null) : null,
      voice: document.querySelector('[data-testid="voice-status"]')?.getAttribute('data-state') ?? null,
      bytesFromPeer: id ? (stats.peers[id]?.bytesReceived ?? 0) : 0,
      visibility: document.visibilityState,
    };
  }, peerId ?? null);

/** Starts the app and attaches to its WebView (Playwright's Android support; debug builds expose DevTools). */
async function attachToWebView(cleanup) {
  adb('shell', 'cmd', 'location', 'set-location-enabled', 'true');
  geoFix(emuAt(0));
  const [device] = await android.devices({ omitDriverInstall: true });
  if (!device) throw new Error('no Android device found by adb');
  cleanup.push(() => device.close());
  adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`);
  const webview = await device.webView({ pkg: PKG }, { timeout: 30_000 });
  const page = await webview.page();
  await page.evaluate(() => localStorage.setItem('intercom:debug', '1'));
  await page.reload();
  return page;
}

async function main() {
  const cleanup = [];
  const results = { screenOffS: SCREEN_OFF_S, silent: SILENT };
  try {
    // Desktop rider: fake mic speaking in a loop, so the emulator has voice to receive.
    const desktop = await chromium.launch({
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${MIC}`, '--autoplay-policy=no-user-gesture-required'],
    });
    cleanup.push(() => desktop.close());
    const ctx = await desktop.newContext({
      viewport: { width: 390, height: 844 },
      permissions: ['geolocation', 'microphone'],
      geolocation: { latitude: DESK_AT.lat, longitude: DESK_AT.lng, accuracy: 5 },
    });
    await ctx.addInitScript(() => localStorage.setItem('intercom:debug', '1'));
    const desk = await ctx.newPage();
    await desk.goto(DESKTOP_URL);
    await tid(desk, 'join-name').fill('Desk');
    await tid(desk, 'home-create').click();
    await tid(desk, 'ride-screen').waitFor({ timeout: 30_000 });
    const code = await desk.evaluate(() => window.__intercom.state().ride.ride.code);
    log(`desktop created ride ${code}`);

    const emu = await attachToWebView(cleanup);
    await tid(emu, 'join-name').fill('Emu');
    await tid(emu, 'home-join-code').fill(code);
    await tid(emu, 'home-join-submit').click();
    await tid(emu, 'ride-screen').waitFor({ timeout: 60_000 });
    const emuId = (await readState(emu)).selfId;
    const deskId = (await readState(desk)).selfId;
    log(`emulator joined as ${emuId}`);

    for (const [name, page, peer] of [['desktop', desk, emuId], ['emulator', emu, deskId]]) {
      await waitFor(async () => {
        const s = await readState(page, peer);
        return s.riders === 2 && s.voice === 'connected' && s.bytesFromPeer > 0;
      }, `${name}: both riders, voice connected, audio arriving`, 60_000);
    }
    log('both riders in, voice connected both ways');
    await waitFor(async () => {
      const s = await readState(desk, emuId);
      return s.peer.t !== null && s.marker === 'live';
    }, "desktop: the emulator rider's first position is on the map");

    if (NO_KEEPALIVE) {
      results.keepAlive = await emu.evaluate(async () => {
        const rs = window.Capacitor.Plugins.RideService;
        await rs.start({ title: 'Ride in progress', text: 'Negative control: no WebView keep-alive', keepAlive: false });
        return (await rs.getStatus()).keepAlive;
      });
      log(`negative control: ride service restarted with keepAlive=${results.keepAlive}`);
    }
    if (adb('shell', 'locksettings', 'get-disabled') === 'true') {
      adb('shell', 'locksettings', 'set-disabled', 'false');
      cleanup.push(() => adb('shell', 'locksettings', 'set-disabled', 'true'));
    }
    adb('shell', 'input', 'keyevent', 'KEYCODE_SLEEP');
    await sleep(2_000);
    results.wakefulness = adb('shell', 'dumpsys', 'power').match(/mWakefulness=(\w+)/)?.[1] ?? 'unknown';
    results.locked = /isKeyguardShowing=true/.test(adb('shell', 'dumpsys', 'window'));
    const activities = adb('shell', 'dumpsys', 'activity', 'activities');
    const record = activities.indexOf(`ActivityRecord{`, activities.indexOf(`${PKG}/.MainActivity`) - 200);
    results.activityState = activities.slice(record, record + 4_000).match(/\bstate=(\w+)/)?.[1] ?? 'unknown';
    results.foregroundService = /isForeground=true/.test(adb('shell', 'dumpsys', 'activity', 'services', PKG));
    log(`screen off (wakefulness=${results.wakefulness}, foreground service=${results.foregroundService})`);
    if (DOZE) {
      cleanup.push(() => {
        adb('shell', 'dumpsys', 'deviceidle', 'unforce');
        adb('shell', 'dumpsys', 'battery', 'reset');
      });
      adb('shell', 'dumpsys', 'battery', 'unplug');
      adb('shell', 'dumpsys', 'deviceidle', 'force-idle', 'deep');
      results.doze = adb('shell', 'dumpsys', 'deviceidle', 'get', 'deep');
      log(`forced deep Doze (state=${results.doze})`);
    }

    const start = Date.now();
    const deskStart = await readState(desk, emuId);
    const emuStart = await readState(emu, deskId);
    const samples = [];
    const emuProbes = [];
    let step = 1;
    let lastT = deskStart.peer.t;
    let lastChangeAt = start;
    let maxGapMs = 0;
    while (Date.now() - start < SCREEN_OFF_S * 1_000) {
      if ((Date.now() - start) / 2_000 >= step) geoFix(emuAt(step++));
      const s = await readState(desk, emuId);
      if (s.peer.t !== lastT) {
        maxGapMs = Math.max(maxGapMs, Date.now() - lastChangeAt);
        lastT = s.peer.t;
        lastChangeAt = Date.now();
      }
      samples.push({ ms: Date.now() - start, ...s });
      if (samples.length % 10 === 0) {
        // The emulator page must still run JS with the screen off: a frozen page can't answer.
        emuProbes.push(await withTimeout(readState(emu, deskId), 5_000).then((e) => ({ ms: Date.now() - start, ok: true, ...e }), (err) => ({ ms: Date.now() - start, ok: false, error: String(err) })));
      }
      await sleep(1_000);
    }
    maxGapMs = Math.max(maxGapMs, Date.now() - lastChangeAt);
    const deskEnd = samples.at(-1);
    const emuEnd = await withTimeout(readState(emu, deskId), 5_000).catch((err) => ({ error: String(err) }));

    Object.assign(results, {
      fixesFed: step - 1,
      movedM: Math.round((deskEnd.peer.lat - deskStart.peer.lat) * 111_320),
      maxLocationGapMs: maxGapMs,
      markerStates: [...new Set(samples.map((s) => s.marker))],
      peerAlwaysOnline: samples.every((s) => s.peer.online === true),
      desktopVoiceStates: [...new Set(samples.map((s) => s.voice))],
      bytesFromEmulator: deskEnd.bytesFromPeer - deskStart.bytesFromPeer,
      bytesFromDesktop: (emuEnd.bytesFromPeer ?? 0) - emuStart.bytesFromPeer,
      emulatorProbes: { answered: emuProbes.filter((p) => p.ok).length, of: emuProbes.length },
      emulatorVisibility: [...new Set(emuProbes.map((p) => p.visibility ?? 'no answer'))],
      emulatorMaxProbeGapMs: Math.max(0, ...emuProbes.filter((p) => p.ok).map((p, i, ok) => (i ? p.ms - ok[i - 1].ms : 0))),
      emulatorEnd: emuEnd,
    });
    const checks = {
      'screen was off': results.wakefulness !== 'Awake',
      'locked, app activity stopped': results.locked && results.activityState === 'STOPPED',
      ...(DOZE && { 'device was in deep Doze': results.doze === 'IDLE' && adb('shell', 'dumpsys', 'deviceidle', 'get', 'deep') === 'IDLE' }),
      'ride foreground service running': results.foregroundService,
      'emulator rider moved on the desktop map': results.movedM > (SCREEN_OFF_S / 2) * STEP_M * 0.8,
      'no gap in position updates near riderStaleMs': maxGapMs < STALE_MS - 5_000,
      'marker never stale or lost': results.markerStates.every((m) => m === 'live'),
      'emulator rider stayed online': results.peerAlwaysOnline,
      'desktop voice stayed connected': results.desktopVoiceStates.every((v) => v === 'connected'),
      'voice from the emulator kept arriving': results.bytesFromEmulator > 0,
      'voice from the desktop kept arriving': results.bytesFromDesktop > 0,
      'emulator page kept running JS': emuProbes.length > 0 && emuProbes.every((p) => p.ok) && emuEnd.connection === 'connected',
    };
    results.checks = checks;
    console.log(JSON.stringify(results, null, 2));
    const failed = Object.entries(checks).filter(([, ok]) => !ok);
    log(failed.length ? `FAIL: ${failed.map(([k]) => k).join('; ')}` : `PASS: ${Object.keys(checks).length} checks over ${SCREEN_OFF_S} s with the screen off`);
    process.exitCode = failed.length ? 1 : 0;
  } finally {
    try {
      adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
      adb('shell', 'wm', 'dismiss-keyguard');
    } catch {
      /* emulator gone */
    }
    for (const fn of cleanup.reverse()) await Promise.resolve().then(fn).catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
