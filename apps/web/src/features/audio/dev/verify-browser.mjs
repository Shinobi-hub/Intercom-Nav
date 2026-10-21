#!/usr/bin/env node
/**
 * Real-browser checks for the audio engine and voice transports, against the dev harness.
 *
 *   (cd apps/web && npx vite --port 5176)            # harness at /audio-dev.html
 *   node apps/web/src/features/audio/dev/verify-browser.mjs [solo] [mesh] [livekit]
 *
 * Chromium's fake mic plays __fixtures__/mic-loop.wav (2 s quiet, ~2 s speech, 3.5 s quiet, looped).
 * LiveKit needs `livekit-server --dev` on ws://127.0.0.1:7880 (devkey/secret).
 */
import { chromium } from '@playwright/test';
import { AccessToken } from 'livekit-server-sdk';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.HARNESS_URL ?? 'http://127.0.0.1:5176/audio-dev.html';
const WAV = join(dirname(fileURLToPath(import.meta.url)), '..', '__fixtures__', 'mic-loop.wav');
const LK_URL = process.env.LIVEKIT_URL ?? 'ws://127.0.0.1:7880';
const which = new Set(process.argv.slice(2).length ? process.argv.slice(2) : ['solo', 'mesh', 'livekit']);
const RIDER = { A: '00000000-0000-4000-8000-00000000000a', B: '00000000-0000-4000-8000-00000000000b' };

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${WAV}`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const results = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openHarness(context, query = '') {
  const page = await context.newPage();
  page.on('console', (m) => m.type() === 'error' && console.log(`[page ${query}]`, m.text()));
  page.on('pageerror', (e) => console.log(`[page ${query}] pageerror`, e.message));
  await page.goto(`${BASE}${query}`);
  await page.getByTestId('harness-start').click();
  await page.waitForFunction(() => window.__intercom?.audio?.outgoingTrackState() === 'live', null, { timeout: 15_000 });
  return page;
}

/** Speech onsets/ends in the raw mic level, and what the VAD, VOX gate and duck gain did around them. */
function analyse(samples, duckLevel) {
  const events = [];
  let quietSince = samples[0]?.t ?? 0;
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i];
    if (s.micDb < -55) continue;
    if (s.micDb > -45 && s.t - quietSince > 1_000) {
      // Onset: first loud sample after a second of quiet. End: last loud sample before >1 s quiet.
      const onset = s.t;
      let end = onset;
      for (let k = i; k < samples.length && samples[k].t - end < 1_000; k++) if (samples[k].micDb > -45) end = samples[k].t;
      events.push({ onset, end });
    }
    quietSince = s.t;
  }
  return events
    .filter((e) => e.end < samples.at(-1).t - 2_000)
    .map(({ onset, end }) => {
      const after = (t, pred) => samples.find((s) => s.t >= t && pred(s))?.t ?? NaN;
      const vadOn = after(onset - 50, (s) => s.speaking.self);
      const gateOpen = after(onset - 50, (s) => s.voxGate > 0.9);
      const ducked = after(onset - 50, (s) => s.duckGain <= duckLevel + 0.05 * (1 - duckLevel));
      const musicDown = after(onset - 50, (s) => s.musicDb < -16);
      const vadOff = after(end, (s) => !s.speaking.self);
      const recovered = after(vadOff, (s) => s.duckGain >= 0.95);
      return {
        vadOnsetMs: Math.round(vadOn - onset),
        voxGateOpenMs: Math.round(gateOpen - onset),
        duckedMs: Math.round(ducked - onset),
        musicDownMs: Math.round(musicDown - onset),
        vadReleaseMs: Math.round(vadOff - end),
        duckRecoveredAfterReleaseMs: Math.round(recovered - vadOff),
      };
    });
}

if (which.has('solo')) {
  const context = await browser.newContext();
  const page = await openHarness(context, '?mode=vox');
  await page.evaluate(async () => {
    await window.__harness.addTestTone();
    await window.__harness.engine.music.play();
  });
  await page.waitForFunction(() => window.__intercom.audio.musicState().playing);
  const backend = await page.evaluate(() => window.__harness.engine.vadBackend);
  await page.evaluate(() => window.__harness.probe.start(20_000));
  await sleep(17_000);
  const samples = await page.evaluate(() => window.__harness.probe.stop());
  const runs = analyse(samples, 0.3);
  const sos = await page.evaluate(async () => {
    const a = window.__intercom.audio;
    window.__harness.engine.setSosMode(true);
    await new Promise((r) => setTimeout(r, 60));
    const muted = a.musicGain();
    window.__harness.engine.setSosMode(false);
    return { musicGainAfter60ms: +muted.toFixed(4) };
  });
  const alerts = await page.evaluate(async () => ({ peaksDb: await window.__harness.measureAlertPeaks(), sirenHz: await window.__harness.sirenPitchTrack() }));
  results.solo = { vadBackend: backend, samples: samples.length, runs, sos, alerts };
  await context.close();
}

async function voicePair(name, queryFor) {
  const context = await browser.newContext();
  const a = await openHarness(context, queryFor('A'));
  const b = await openHarness(context, queryFor('B'));
  const heard = async (page, from) => {
    await page.waitForFunction((id) => window.__intercom.audio.remoteRiders().includes(id), from, { timeout: 20_000 });
    const t0 = Date.now();
    await page.waitForFunction((id) => window.__intercom.audio.vad()[id]?.speaking === true, from, { timeout: 20_000 });
    const s1 = await page.evaluate(() => window.__harness.stats());
    await sleep(2_000);
    const s2 = await page.evaluate(() => window.__harness.stats());
    const peer = (s) => s.peers[from] ?? { bytesReceived: 0 };
    return {
      remoteVadFiredAfterMs: Date.now() - t0,
      inboundBytesGrowth: peer(s2).bytesReceived - peer(s1).bytesReceived,
      peerState: peer(s2).state,
      rttMs: peer(s2).rttMs,
      bytesSent: s2.bytesSent,
      voiceState: await page.evaluate(() => window.__intercom.state().local.voice.state),
    };
  };
  results[name] = { BhearsA: await heard(b, RIDER.A), AhearsB: await heard(a, RIDER.B) };
  await context.close();
}

if (which.has('mesh')) await voicePair('mesh', (r) => `?mesh=1&rider=${r}`);

if (which.has('livekit')) {
  const room = `harness-${Date.now()}`;
  const token = async (identity) => {
    const at = new AccessToken('devkey', 'secret', { identity, ttl: '10m' });
    at.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });
    return at.toJwt();
  };
  const tokens = { A: await token(RIDER.A), B: await token(RIDER.B) };
  await voicePair('livekit', (r) => `?lk=${encodeURIComponent(LK_URL)}&token=${tokens[r]}&rider=${r}`);
}

await browser.close();
console.log(JSON.stringify(results, null, 2));
