#!/usr/bin/env node
/**
 * Regenerates the VAD test fixtures in this folder (16 kHz mono 16-bit WAV) and fixtures.json,
 * which records where the speech is in each file.
 *
 *   node apps/web/src/features/audio/__fixtures__/generate.mjs
 *
 * macOS only: real speech comes from `say` (several voices) converted with `afconvert`.
 * Noise is synthesized from a fixed seed, so reruns only differ if the system voices change.
 *
 * `say` output is not bit-identical between runs, so always commit the WAVs and fixtures.json
 * from the same run.
 *
 * wind-captured.wav and wind-received.wav are not generated: they were recorded in the e2e wind
 * scenario (two rider browsers over LiveKit) by tapping the VAD input with a ScriptProcessor, then
 * cut to 8 s and resampled to 16 kHz with ffmpeg. They show what the synthetic wind becomes after
 * WebRTC capture processing and Opus/DTX, which is what the VAD has to survive in practice.
 *
 * Levels are chosen to resemble a phone/helmet mic after the browser's own processing:
 * mic self-noise around -70 dBFS, speech at -24 dBFS active level, wind and engine noise
 * in the -26..-30 dBFS range with the energy where real wind and engines put it.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = dirname(fileURLToPath(import.meta.url));
const SR = 16_000;
const FRAME = SR / 100; // 10 ms

// ---- utilities --------------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand) {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

const dbToGain = (db) => 10 ** (db / 20);

function rmsDb(x, from = 0, to = x.length) {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return 10 * Math.log10(s / Math.max(1, to - from) + 1e-20);
}

/** RBJ cookbook biquad, applied in place. */
function biquad(x, type, f0, q) {
  const w = (2 * Math.PI * f0) / SR;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  let b0, b1, b2;
  if (type === 'lowpass') {
    b0 = (1 - cos) / 2;
    b1 = 1 - cos;
    b2 = (1 - cos) / 2;
  } else {
    b0 = (1 + cos) / 2;
    b1 = -(1 + cos);
    b2 = (1 + cos) / 2;
  }
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i];
    const y0 = (b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    x[i] = y0;
  }
  return x;
}

function scaleTo(x, targetDb, from = 0, to = x.length) {
  const g = dbToGain(targetDb - rmsDb(x, from, to));
  for (let i = 0; i < x.length; i++) x[i] *= g;
  return x;
}

function concat(...parts) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function addInto(dst, src, offset = 0) {
  for (let i = 0; i < src.length && offset + i < dst.length; i++) dst[offset + i] += src[i];
  return dst;
}

// ---- WAV I/O ----------------------------------------------------------------------------------

/** Minimal PCM16 WAV reader that walks chunks (afconvert adds FLLR padding chunks). */
function readWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV');
  let off = 12;
  let fmt = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = { channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      if (!fmt || fmt.bits !== 16) throw new Error('expected 16-bit PCM');
      const frames = Math.floor(size / 2 / fmt.channels);
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) out[i] = buf.readInt16LE(body + i * 2 * fmt.channels) / 32768;
      return { sampleRate: fmt.sampleRate, samples: out };
    }
    off = body + size + (size & 1);
  }
  throw new Error('no data chunk');
}

function writeWav(name, samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(v < 0 ? v * 32768 : v * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SR, 24);
  header.writeUInt32LE(SR * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  writeFileSync(join(OUT_DIR, name), Buffer.concat([header, data]));
}

// ---- sources ----------------------------------------------------------------------------------

const tmp = mkdtempSync(join(tmpdir(), 'intercom-fixtures-'));

/** Real TTS speech at 16 kHz, trimmed of the silence `say` leaves at both ends. */
function say(voice, text) {
  const aiff = join(tmp, `${voice}.aiff`);
  const wav = join(tmp, `${voice}.wav`);
  execFileSync('say', ['-v', voice, '-o', aiff, text]);
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav]);
  const { sampleRate, samples } = readWav(readFileSync(wav));
  if (sampleRate !== SR) throw new Error(`afconvert gave ${sampleRate} Hz`);
  let a = 0;
  let b = samples.length;
  while (a < b && Math.abs(samples[a]) < 1e-3) a++;
  while (b > a && Math.abs(samples[b - 1]) < 1e-3) b--;
  return samples.slice(a, b);
}

/** Copy of `x` limited to the telephone band (300-3400 Hz) the VAD listens to. */
function speechBand(x) {
  const band = Float32Array.from(x);
  biquad(band, 'highpass', 300, 0.5412);
  biquad(band, 'highpass', 300, 1.3066);
  return biquad(band, 'lowpass', 3_400, Math.SQRT1_2);
}

function frameDbs(x) {
  return Array.from({ length: Math.floor(x.length / FRAME) }, (_, i) => rmsDb(x, i * FRAME, (i + 1) * FRAME));
}

/**
 * Ground truth for `clean` placed at `offset` samples into `noise`: speech segments in seconds.
 * A frame is speech when the utterance is audible in the VAD's band: at least 3 dB above the
 * noise there, and within 50 dB of the utterance's loudest frame. So an unvoiced /s/ (mostly
 * above 3.4 kHz) counts in quiet but not under wind that masks it. Gaps shorter than 400 ms are
 * merged: a VAD with a 300 ms hangover is expected to bridge them.
 */
function segmentsOf(clean, noise, offset) {
  const speechDb = frameDbs(speechBand(clean));
  const noiseDb = frameDbs(speechBand(noise.subarray(offset, offset + clean.length)));
  const max = Math.max(...speechDb);
  const segs = [];
  speechDb.forEach((db, i) => {
    if (db < noiseDb[i] + 3 || db < max - 50) return;
    const start = (offset + i * FRAME) / SR;
    const end = (offset + (i + 1) * FRAME) / SR;
    const last = segs[segs.length - 1];
    if (last && start - last[1] < 0.4) last[1] = end;
    else segs.push([start, end]);
  });
  return segs.map(([s, e]) => [+s.toFixed(3), +e.toFixed(3)]);
}

/** Frames of `clean` that carry speech, by level alone (used to set the active speech level). */
function speechFrames(clean) {
  const db = frameDbs(speechBand(clean));
  const max = Math.max(...db);
  return db.map((d) => d > max - 35);
}

/** Speech scaled to an active level (RMS over speech frames) of `db` dBFS. */
function atActiveLevel(clean, db) {
  const frames = speechFrames(clean);
  let s = 0;
  let n = 0;
  frames.forEach((on, i) => {
    if (!on) return;
    for (let k = i * FRAME; k < (i + 1) * FRAME; k++) s += clean[k] * clean[k];
    n += FRAME;
  });
  const g = dbToGain(db - 10 * Math.log10(s / n));
  return clean.map((v) => v * g);
}

/** Mic self-noise: white noise tilted slightly toward the lows, like a real capsule after AGC. */
function micNoise(seconds, db, seed) {
  const rand = mulberry32(seed);
  const x = new Float32Array(Math.round(seconds * SR));
  let lp = 0;
  for (let i = 0; i < x.length; i++) {
    const w = gaussian(rand);
    lp = 0.7 * lp + 0.3 * w;
    x[i] = 0.6 * w + 0.8 * lp;
  }
  return scaleTo(x, db);
}

/**
 * Wind buffeting: brown noise, low-passed (wind energy sits far below the speech band), with a
 * gust envelope made of 0.3-1.5 Hz modulations plus a slow random wander.
 */
function wind(seconds, db, seed) {
  const rand = mulberry32(seed);
  const n = Math.round(seconds * SR);
  const x = new Float32Array(n);
  let brown = 0;
  for (let i = 0; i < n; i++) {
    brown = 0.998 * brown + gaussian(rand) * 0.05;
    x[i] = brown;
  }
  biquad(x, 'highpass', 20, Math.SQRT1_2);
  biquad(x, 'lowpass', 700, Math.SQRT1_2);
  const p = [rand(), rand(), rand(), rand()].map((v) => v * 2 * Math.PI);
  let wander = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    if (i % FRAME === 0) wander = 0.995 * wander + gaussian(rand) * 0.25;
    const gustDb =
      7 * Math.sin(2 * Math.PI * 0.31 * t + p[0]) +
      4 * Math.sin(2 * Math.PI * 0.73 * t + p[1]) +
      2.5 * Math.sin(2 * Math.PI * 1.47 * t + p[2]) +
      wander;
    x[i] *= dbToGain(gustDb);
  }
  return scaleTo(x, db);
}

/**
 * Motorcycle engine: harmonic series on a firing frequency that revs between ~35 and ~75 Hz,
 * cycle-to-cycle roughness, plus broadband exhaust/intake noise.
 */
function engineHum(seconds, db, seed) {
  const rand = mulberry32(seed);
  const n = Math.round(seconds * SR);
  const x = new Float32Array(n);
  const harmonics = [];
  for (let k = 1; k <= 90; k++) harmonics.push({ k, amp: (1 / k ** 0.75) * (0.7 + 0.6 * rand()), phase: rand() * 2 * Math.PI });
  const p1 = rand() * 2 * Math.PI;
  let phase = 0;
  let rough = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f0 = 52 + 14 * Math.sin(2 * Math.PI * 0.11 * t) + 7 * Math.sin(2 * Math.PI * 0.37 * t + p1);
    phase += (2 * Math.PI * f0) / SR;
    if (i % 80 === 0) rough = 0.9 * rough + gaussian(rand) * 0.06;
    let v = 0;
    for (const h of harmonics) {
      if (h.k * f0 > 7_000) break;
      v += h.amp * Math.sin(h.k * phase + h.phase);
    }
    x[i] = v * (1 + rough);
  }
  const exhaust = new Float32Array(n);
  for (let i = 0; i < n; i++) exhaust[i] = gaussian(rand);
  biquad(exhaust, 'lowpass', 1_800, Math.SQRT1_2);
  scaleTo(exhaust, rmsDb(x) - 14);
  addInto(x, exhaust);
  return scaleTo(x, db);
}

// ---- fixtures ---------------------------------------------------------------------------------

const SPEECH_DB = -24;
const MIC_NOISE_DB = -70;
const fixtures = {};

function record(name, samples, info) {
  const peak = samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  if (peak > 0.99) throw new Error(`${name} clips (peak ${peak.toFixed(3)})`);
  writeWav(name, samples);
  fixtures[name] = { seconds: +(samples.length / SR).toFixed(3), ...info };
  console.log(`${name.padEnd(22)} ${(samples.length / SR).toFixed(2)} s  peak ${(20 * Math.log10(peak)).toFixed(1)} dBFS`);
}

/** Utterance over `noise`, starting `lead` s in and followed by `tail` s. */
function placeSpeech(name, voice, text, lead, tail, makeNoise, info = {}) {
  const clean = atActiveLevel(say(voice, text), SPEECH_DB);
  const offset = Math.round(lead * SR);
  const noise = makeNoise((offset + clean.length + Math.round(tail * SR)) / SR);
  const out = Float32Array.from(noise);
  addInto(out, clean, offset);
  record(name, out, { kind: 'speech', voice, text, ...info, segments: segmentsOf(clean, noise, offset) });
}

function speechFixture(name, voice, text, lead, tail, seed) {
  placeSpeech(name, voice, text, lead, tail, (s) => micNoise(s, MIC_NOISE_DB, seed));
}

speechFixture('speech-samantha.wav', 'Samantha', 'Heads up, gravel on the road ahead.', 0.8, 1.2, 11);
speechFixture('speech-daniel.wav', 'Daniel', 'Pulling over for fuel at the next exit.', 0.8, 1.2, 12);
speechFixture('speech-rishi.wav', 'Rishi', 'Can everyone hear me? Testing, one, two, three.', 0.8, 1.2, 13);
speechFixture('speech-karen.wav', 'Karen', 'Stopping for coffee in ten minutes.', 0.8, 1.2, 14);

// Speech over moderate wind: wind at -30 dBFS (gusting roughly +-10 dB) under -24 dBFS speech.
placeSpeech(
  'speech-wind.wav',
  'Daniel',
  'Slow down, there is a speed camera after the bridge.',
  1.5,
  1.5,
  (s) => addInto(wind(s, -30, 21), micNoise(s, MIC_NOISE_DB, 22)),
  { noise: 'wind -30 dBFS' },
);

{
  const out = wind(8, -26, 31);
  addInto(out, micNoise(8, MIC_NOISE_DB, 32));
  record('wind.wav', out, { kind: 'noise', noise: 'wind -26 dBFS, gusting', segments: [] });
}

{
  const out = engineHum(6, -26, 41);
  addInto(out, micNoise(6, MIC_NOISE_DB, 42));
  record('hum.wav', out, { kind: 'noise', noise: 'engine -26 dBFS, revving 35-75 Hz firing rate', segments: [] });
}

{
  // A muted/idle input: a quarter second of digital silence, then quiet room tone.
  const out = concat(new Float32Array(Math.round(0.25 * SR)), micNoise(1.25, -72, 51));
  record('silence.wav', out, { kind: 'noise', noise: 'digital silence then -72 dBFS room tone', segments: [] });
}

// Fake-microphone input for browser checks (Chrome loops it): a long quiet tail so the ducking
// hold + release can finish before the next loop.
placeSpeech('mic-loop.wav', 'Samantha', 'Heads up, gravel on the road ahead.', 2, 3.5, (s) => micNoise(s, MIC_NOISE_DB, 61));

// Captured fixtures (marked "captured" in fixtures.json) were recorded from the real browser pipeline,
// not synthesized here: keep their entries, and their WAVs are left alone.
try {
  const previous = JSON.parse(readFileSync(join(OUT_DIR, 'fixtures.json'), 'utf8')).fixtures ?? {};
  for (const [name, info] of Object.entries(previous)) if (info.captured) fixtures[name] = info;
} catch {
  /* first run: nothing to keep */
}

writeFileSync(join(OUT_DIR, 'fixtures.json'), `${JSON.stringify({ sampleRate: SR, fixtures }, null, 2)}\n`);
rmSync(tmp, { recursive: true, force: true });
console.log(`wrote ${Object.keys(fixtures).length} fixtures to ${OUT_DIR}`);
