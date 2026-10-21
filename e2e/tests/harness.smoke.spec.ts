/**
 * Proves the rig before blaming the app: audio fixtures, fake microphones, rider browser setup,
 * LiveKit and direct WebRTC between rider browsers on this machine. Uses a static page
 * (harness/smoke.html), no app code, so it runs even while the app is broken:
 *
 *   E2E_SERVERS=0 npx playwright test -c e2e --project=harness
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { LIVEKIT_UMD, livekitToken, startHarnessServer, type HarnessServer } from '../harness/server';
import { speechSidecar, type FakeMic } from '../helpers/audioFixtures';
import { E2E_DIR, isReachable, LIVEKIT_HTTP_URL, LIVEKIT_WS_URL } from '../helpers/env';
import { PUNE, type Rider } from '../helpers/rider';
import { expect, test } from '../helpers/test';
import { waitFor } from '../helpers/wait';

interface Frame {
  t: number;
  db: number;
}

interface Span {
  start: number;
  end: number;
}

/** window.smoke in harness/smoke.html. */
interface SmokeApi {
  startMic(kind: 'raw' | 'processed'): Promise<MediaTrackSettings>;
  frames(meter: string, from?: number): Frame[];
  geolocation(): Promise<{ lat: number; lng: number; accuracy: number }>;
  permissions(): Promise<Record<string, string>>;
  viewport(): { width: number; height: number; dpr: number; touch: number };
  hostCandidates(): Promise<string[]>;
  meshOffer(): Promise<RTCSessionDescriptionInit>;
  meshAnswer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit>;
  meshAccept(answer: RTCSessionDescriptionInit): Promise<void>;
  meshPair(): Promise<{ local?: string; remote?: string; bytesReceived?: number; state?: string }>;
  livekitJoin(url: string, token: string, publish: boolean): Promise<string>;
}

declare global {
  interface Window {
    smoke?: SmokeApi;
    LivekitClient?: unknown;
  }
}

const frames = (page: Page, meter: string): Promise<Frame[]> => page.evaluate((m) => window.smoke!.frames(m), meter);

/** Loud stretches (> loudDb) with gaps under bridgeMs merged. A stretch already running at the start is skipped. */
function loudSpans(fs: readonly Frame[], loudDb = -35, bridgeMs = 400): Span[] {
  const out: Span[] = [];
  let cur: Span | null = null;
  let sawQuiet = false;
  for (const f of fs) {
    if (f.db <= loudDb) {
      sawQuiet = true;
    } else if (cur && f.t - cur.end <= bridgeMs) {
      cur.end = f.t;
    } else if (sawQuiet) {
      if (cur) out.push(cur);
      cur = { start: f.t, end: f.t };
    }
  }
  if (cur) out.push(cur);
  return out;
}

const within = (f: Frame, spans: readonly Span[], margin = 0) => spans.some((s) => f.t >= s.start - margin && f.t <= s.end + margin);
/** Energy mean of dB frames: what an RMS meter over the whole stretch would read. */
const meanDb = (fs: readonly Frame[]) => 10 * Math.log10(fs.reduce((a, f) => a + 10 ** (f.db / 10), 0) / Math.max(1, fs.length));
const round1 = (v: number) => Math.round(v * 10) / 10;

async function openHarness(rider: Rider, server: HarnessServer): Promise<void> {
  await rider.page.goto(server.url);
  await rider.page.waitForFunction(() => window.smoke !== undefined);
}

let server: HarnessServer;
test.beforeAll(async () => {
  server = await startHarnessServer();
});
test.afterAll(async () => {
  await server?.close();
});

test('audio fixtures pass verification (RMS per window)', async () => {
  const res = spawnSync(process.execPath, [join(E2E_DIR, 'fixtures', 'generate.mjs'), '--check'], { encoding: 'utf8' });
  expect(res.status, `fixtures/generate.mjs --check failed:\n${res.stderr}${res.stdout}`).toBe(0);
  const side = speechSidecar();
  expect(side.cycleMs).toBe(12_000);
  expect(side.speech.startMs).toBe(3_000);
  expect(side.speech.durationMs).toBeGreaterThan(2_500);
  expect(side.speech.durationMs).toBeLessThan(3_500);
});

test('fake microphones deliver the fixtures to getUserMedia', { tag: '@slow' }, async ({ riders }, testInfo) => {
  const mics: FakeMic[] = ['speech', 'silence', 'wind', 'tone'];
  const launched = await riders.launchAll(mics.map((audio) => ({ name: `mic-${audio}`, audio })));
  const byMic = Object.fromEntries(mics.map((m, i) => [m, launched[i]])) as Record<FakeMic, Rider>;
  await Promise.all(
    launched.map(async (r) => {
      await openHarness(r, server);
      // raw = the file as Chrome delivers it; processed = what the app asks for (AEC + NS + AGC).
      await r.page.evaluate(async () => {
        await window.smoke!.startMic('raw');
        await window.smoke!.startMic('processed');
      });
    }),
  );

  // Two complete speech windows one loop apart: the file plays, and Chrome loops it.
  const side = speechSidecar();
  const speechPage = byMic.speech.page;
  const spans = await waitFor(
    async () => {
      const fs = await frames(speechPage, 'mic-raw');
      const ss = loudSpans(fs);
      const last = fs[fs.length - 1];
      return ss.length >= 2 && last && last.t - ss[1]!.end > 600 ? ss.slice(0, 2) : null;
    },
    { timeout: 45_000, interval: 500, message: 'speech fake mic should produce two speech windows one 12 s loop apart' },
  );
  const [w1, w2] = spans as [Span, Span];
  const raw = await frames(speechPage, 'mic-raw');
  const processed = await frames(speechPage, 'mic-processed');
  const processedSpans = loudSpans(processed);
  const speech = {
    loopMs: w2.start - w1.start,
    windowMs: [w1.end - w1.start, w2.end - w2.start],
    sidecarMs: side.speech.durationMs,
    rawSpeechDb: round1(meanDb(raw.filter((f) => within(f, spans)))),
    rawQuietDb: round1(meanDb(raw.filter((f) => f.t > raw[20]!.t && !within(f, spans, 400)))),
    processedSpeechDb: round1(meanDb(processed.filter((f) => within(f, processedSpans)))),
    processedQuietDb: round1(meanDb(processed.filter((f) => f.t > processed[20]!.t && !within(f, processedSpans, 400)))),
  };

  const steady: Record<string, { rawDb: number; rawMaxDb: number; processedDb: number; processedMaxDb: number }> = {};
  for (const mic of ['silence', 'wind', 'tone'] as const) {
    const page = byMic[mic].page;
    await waitFor(async () => (await frames(page, 'mic-raw')).length > 150, { timeout: 15_000, message: `${mic} meter should run` });
    const r = (await frames(page, 'mic-raw')).slice(20); // skip device start-up
    const p = (await frames(page, 'mic-processed')).slice(20);
    steady[mic] = {
      rawDb: round1(meanDb(r)),
      rawMaxDb: round1(Math.max(...r.map((f) => f.db))),
      processedDb: round1(meanDb(p)),
      processedMaxDb: round1(Math.max(...p.map((f) => f.db))),
    };
  }
  const report = { speech, ...steady };
  await testInfo.attach('fake-mic-levels.json', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
  console.log(`fake mic levels (dBFS): ${JSON.stringify(report)}`);

  expect(Math.abs(speech.loopMs - side.cycleMs), `loop period ${speech.loopMs} ms`).toBeLessThan(400);
  for (const ms of speech.windowMs) expect(Math.abs(ms - side.speech.durationMs), `speech window ${ms} ms vs sidecar`).toBeLessThan(600);
  expect(speech.rawSpeechDb, 'speech window level (raw)').toBeGreaterThan(-30);
  expect(speech.rawQuietDb, 'quiet between speech windows (raw)').toBeLessThan(-50);
  expect(speech.processedSpeechDb - speech.processedQuietDb, 'speech stands out after the app\'s processing').toBeGreaterThan(20);
  expect(steady.silence!.rawMaxDb, 'silence fixture stays quiet').toBeLessThan(-55);
  expect(steady.silence!.processedMaxDb, 'silence stays quiet after processing').toBeLessThan(-45);
  expect(steady.wind!.rawDb, 'wind fixture level').toBeGreaterThan(-32);
  expect(steady.wind!.rawDb, 'wind fixture level').toBeLessThan(-16);
  expect(Math.abs(steady.tone!.rawDb + 15), 'tone fixture at -15 dBFS').toBeLessThan(2);
});

test('rider browsers: geolocation, permissions, phone viewport, real ICE host candidates', async ({ riders }) => {
  const rider = await riders.launch({ name: 'env-check', audio: 'silence' });
  await openHarness(rider, server);
  const env = await rider.page.evaluate(async () => {
    const s = window.smoke!;
    return { geo: await s.geolocation(), perms: await s.permissions(), viewport: s.viewport(), hosts: await s.hostCandidates() };
  });
  expect(env.geo.lat).toBeCloseTo(PUNE.lat, 4);
  expect(env.geo.lng).toBeCloseTo(PUNE.lng, 4);
  expect(env.perms).toEqual({ microphone: 'granted', geolocation: 'granted' });
  expect(env.viewport).toMatchObject({ width: 390, height: 844 });
  expect(env.viewport.touch, 'touch emulation').toBeGreaterThan(0);
  expect(env.hosts.length, 'ICE should gather host candidates').toBeGreaterThan(0);
  expect(env.hosts.filter((h) => h.endsWith('.local')), 'mDNS hiding must be off (merged --disable-features)').toEqual([]);
});

test('LiveKit dev server is reachable', { tag: '@livekit' }, async () => {
  expect(await isReachable(LIVEKIT_HTTP_URL), `LiveKit at ${LIVEKIT_HTTP_URL}`).toBe(true);
});

test('mic audio crosses LiveKit between two rider browsers', { tag: ['@livekit', '@slow'] }, async ({ riders }) => {
  test.skip(!existsSync(LIVEKIT_UMD), `livekit-client UMD build not found at ${LIVEKIT_UMD}`);
  const [speaker, listener] = await riders.launchAll([
    { name: 'lk-speaker', audio: 'speech' },
    { name: 'lk-listener', audio: 'silence' },
  ]);
  const room = `e2e-harness-${Date.now()}`;
  await Promise.all([openHarness(speaker, server), openHarness(listener, server)]);
  for (const r of [speaker, listener]) await r.page.waitForFunction(() => window.LivekitClient !== undefined);
  const join = (r: Rider, identity: string, publish: boolean) =>
    r.page.evaluate(({ url, token, publish }) => window.smoke!.livekitJoin(url, token, publish), {
      url: LIVEKIT_WS_URL,
      token: livekitToken(identity, room),
      publish,
    });
  try {
    await join(listener, 'listener', false);
    await join(speaker, 'speaker', true);
  } catch (e) {
    // Seen on this rig after the network changed (VPN up): signaling connects but ICE fails, because a
    // `--node-ip 127.0.0.1` server only offers loopback candidates and Chrome never uses loopback ones.
    throw new Error(
      `LiveKit media path failed: ${e instanceof Error ? e.message : e}\n` +
        'Likely cause: livekit-server advertises only 127.0.0.1. Restart it with --node-ip <LAN IP> (and bind 0.0.0.0), or drop the VPN.',
    );
  }

  const heard = await waitFor(async () => loudSpans(await frames(listener.page, 'lk-speaker')).length > 0, {
    timeout: 40_000,
    interval: 500,
    message: 'listener should hear the speaker\'s speech through the LiveKit SFU',
  });
  expect(heard).toBe(true);
});

test('mic audio crosses a direct peer connection between two rider browsers', { tag: ['@mesh', '@slow'] }, async ({ riders }) => {
  const [speaker, listener] = await riders.launchAll([
    { name: 'p2p-speaker', audio: 'speech' },
    { name: 'p2p-listener', audio: 'silence' },
  ]);
  await Promise.all([openHarness(speaker, server), openHarness(listener, server)]);
  const offer = await speaker.page.evaluate(() => window.smoke!.meshOffer());
  const answer = await listener.page.evaluate((o) => window.smoke!.meshAnswer(o), offer);
  await speaker.page.evaluate((a) => window.smoke!.meshAccept(a), answer);

  const pair = await waitFor(
    async () => {
      const p = await listener.page.evaluate(() => window.smoke!.meshPair());
      return p.local ? p : null;
    },
    { timeout: 15_000, message: 'peer connection should select a candidate pair' },
  );
  expect(pair, 'direct host-to-host path (no STUN/TURN needed locally)').toMatchObject({ local: 'host', remote: 'host' });
  const heard = await waitFor(async () => loudSpans(await frames(listener.page, 'mesh-remote')).length > 0, {
    timeout: 40_000,
    interval: 500,
    message: 'listener should hear the speaker\'s speech over the peer connection',
  });
  expect(heard).toBe(true);
});
