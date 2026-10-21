#!/usr/bin/env node
/**
 * Audio fixtures for the E2E suite: fake microphones for the riders (Chrome's
 * --use-file-for-fake-audio-capture, which loops the file) and a track for the in-app music player.
 *
 *   node e2e/fixtures/generate.mjs           generate missing or outdated files, then verify all
 *   node e2e/fixtures/generate.mjs --force   regenerate everything, then verify
 *   node e2e/fixtures/generate.mjs --check   verify only; exit 1 when anything is off
 *
 * Output in e2e/fixtures/audio/, all 48 kHz mono 16-bit PCM WAV:
 *   speech-loop.wav   12 s cycle: 3 s quiet, ~3 s of real speech (macOS `say`), quiet until 12 s.
 *                     Chrome loops the file, so the speech repeats every 12 s.
 *   speech-loop.json  Sidecar with the exact speech window (and voiced segments) inside the cycle.
 *   silence.wav       Room-quiet noise floor (about -70 dBFS). Chrome's default fake mic beeps,
 *                     so riders who don't talk get this file.
 *   wind.wav          Gusty, low-frequency wind buffeting at helmet-mic level; no speech.
 *   tone.wav          Steady 440 Hz sine, -15 dBFS RMS, loops seamlessly.
 *   music.wav         30 s of synthetic music (pads, bass, arpeggio, drums) for the music player.
 *   manifest.json     Generator version plus the levels measured by the verification pass.
 *
 * Noise is drawn from a seeded PRNG so every run produces identical files (speech depends on the
 * installed macOS voice). No dependencies beyond Node, `say` and `afconvert`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Bump when the generated audio changes; global setup regenerates fixtures with an older version. */
export const GENERATOR_VERSION = 1;

const SR = 48_000;
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'audio');

const CYCLE_S = 12;
const SPEECH_START_S = 3;
const SPEECH_TARGET_S = 3;
const SPEECH_TOLERANCE_S = 0.3;
const SPEECH_TEXT = 'Fuel stop at the next exit, then we ride on to the lake.';
const VOICES = ['Samantha', 'Daniel', 'Karen', 'Moira'];
const NOISE_FLOOR_DBFS = -70;

const FILES = ['speech-loop.wav', 'speech-loop.json', 'silence.wav', 'wind.wav', 'tone.wav', 'music.wav'];

// ---- small DSP toolkit ------------------------------------------------------------------------

const dbToAmp = (db) => 10 ** (db / 20);
const ampToDb = (amp) => (amp > 0 ? 20 * Math.log10(amp) : -Infinity);

/** Deterministic PRNG (mulberry32), uniform in [0, 1). */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function whiteNoise(n, rand) {
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = rand() * 2 - 1;
  return x;
}

/** RBJ cookbook biquad. Returns a filtered copy. */
function biquad(x, kind, f0, q = Math.SQRT1_2) {
  const w0 = (2 * Math.PI * f0) / SR;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  let b0, b1, b2;
  if (kind === 'lowpass') [b0, b1, b2] = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2];
  else if (kind === 'highpass') [b0, b1, b2] = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
  else if (kind === 'bandpass') [b0, b1, b2] = [alpha, 0, -alpha];
  else throw new Error(`unknown filter ${kind}`);
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = (b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = xi; y2 = y1; y1 = yi;
    y[i] = yi;
  }
  return y;
}

function rms(x, from = 0, to = x.length) {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return to > from ? Math.sqrt(s / (to - from)) : 0;
}

function peak(x) {
  let p = 0;
  for (const v of x) p = Math.max(p, Math.abs(v));
  return p;
}

function scale(x, gain) {
  for (let i = 0; i < x.length; i++) x[i] *= gain;
  return x;
}

function addInto(dst, src, offset = 0, gain = 1) {
  for (let i = 0; i < src.length && offset + i < dst.length; i++) dst[offset + i] += src[i] * gain;
}

/** dBFS of each `frameMs` frame. */
function frameDb(x, frameMs) {
  const len = Math.round((SR * frameMs) / 1000);
  const out = [];
  for (let i = 0; i + len <= x.length; i += len) out.push(ampToDb(rms(x, i, i + len)));
  return out;
}

/** Linear fade over `ms` at both ends (avoids clicks). */
function fadeEdges(x, ms) {
  const n = Math.min(Math.round((SR * ms) / 1000), Math.floor(x.length / 2));
  for (let i = 0; i < n; i++) {
    const g = i / n;
    x[i] *= g;
    x[x.length - 1 - i] *= g;
  }
  return x;
}

/**
 * Makes `x` (length n + fade) loop seamlessly as n samples: the tail beyond n is cross-faded
 * (equal power, for uncorrelated noise) into the head, so sample n-1 flows into sample 0.
 */
function loopable(x, n) {
  const fade = x.length - n;
  const y = x.slice(0, n);
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    y[i] = x[i] * Math.sqrt(t) + x[n + i] * Math.sqrt(1 - t);
  }
  return y;
}

/** Soft limiter: transparent below `ceilingDb`, smoothly saturates above. */
function softLimit(x, ceilingDb) {
  const c = dbToAmp(ceilingDb);
  for (let i = 0; i < x.length; i++) x[i] = c * Math.tanh(x[i] / c);
  return x;
}

// ---- WAV I/O ----------------------------------------------------------------------------------

function writeWav(path, x) {
  const data = Buffer.alloc(x.length * 2);
  for (let i = 0; i < x.length; i++) {
    const v = Math.max(-1, Math.min(1, x[i]));
    data.writeInt16LE(Math.round(v * 32_767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SR, 24);
  header.writeUInt32LE(SR * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
}

/** Reads a 16-bit PCM WAV into floats, walking chunks (afconvert adds FLLR/LIST padding chunks). */
function readWav(path) {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${path}: not a RIFF/WAVE file`);
  }
  let fmt = null;
  let data = null;
  for (let off = 12; off + 8 <= buf.length; ) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, off + 8 + size);
    if (id === 'fmt ') {
      fmt = { format: body.readUInt16LE(0), channels: body.readUInt16LE(2), rate: body.readUInt32LE(4), bits: body.readUInt16LE(14) };
    } else if (id === 'data') {
      data = body;
    }
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error(`${path}: missing fmt or data chunk`);
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error(`${path}: expected 16-bit PCM, got format ${fmt.format}/${fmt.bits} bit`);
  const frames = Math.floor(data.length / (2 * fmt.channels));
  const x = new Float64Array(frames);
  for (let i = 0; i < frames; i++) x[i] = data.readInt16LE(i * 2 * fmt.channels) / 32_768;
  return { ...fmt, samples: x };
}

// ---- generators -------------------------------------------------------------------------------

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${e.stderr || e.message}`);
  }
}

function pickVoice() {
  let list = '';
  try {
    list = run('say', ['-v', '?']);
  } catch {
    return null;
  }
  const installed = new Set(list.split('\n').map((l) => l.split(/\s{2,}/)[0]?.trim()));
  return VOICES.find((v) => installed.has(v)) ?? null;
}

/** First/last sample of the voiced region (frames louder than `thresholdDb`). */
function voicedBounds(x, thresholdDb = -45) {
  const frame = Math.round(SR * 0.01);
  let first = -1;
  let last = -1;
  for (let i = 0; i + frame <= x.length; i += frame) {
    if (ampToDb(rms(x, i, i + frame)) > thresholdDb) {
      if (first < 0) first = i;
      last = i + frame;
    }
  }
  if (first < 0) throw new Error('synthesized speech is silent');
  return [first, last];
}

/** macOS TTS, trimmed to the voiced part and steered (via speaking rate) to ~3 s. */
function synthesizeSpeech() {
  if (process.platform !== 'darwin') throw new Error('speech fixture needs macOS `say` and `afconvert`');
  const voice = pickVoice();
  const tmp = mkdtempSync(join(tmpdir(), 'intercom-e2e-say-'));
  try {
    let rate = 180;
    for (let attempt = 0; attempt < 5; attempt++) {
      const aiff = join(tmp, `speech-${attempt}.aiff`);
      const wav = join(tmp, `speech-${attempt}.wav`);
      run('say', [...(voice ? ['-v', voice] : []), '-r', String(rate), '-o', aiff, SPEECH_TEXT]);
      run('afconvert', ['-f', 'WAVE', '-d', `LEI16@${SR}`, '-c', '1', aiff, wav]);
      const { samples, rate: sr, channels } = readWav(wav);
      if (sr !== SR || channels !== 1) throw new Error(`afconvert produced ${channels} ch @ ${sr} Hz`);
      const [a, b] = voicedBounds(samples);
      const speech = fadeEdges(samples.slice(a, b), 5);
      const seconds = speech.length / SR;
      if (Math.abs(seconds - SPEECH_TARGET_S) <= SPEECH_TOLERANCE_S) return { speech, voice: voice ?? 'default', rate };
      rate = Math.round((rate * seconds) / SPEECH_TARGET_S);
    }
    throw new Error(`could not fit "${SPEECH_TEXT}" into ${SPEECH_TARGET_S}±${SPEECH_TOLERANCE_S} s`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Uniform noise at `db` dBFS RMS. */
function noiseFloor(n, rand, db = NOISE_FLOOR_DBFS) {
  return scale(whiteNoise(n, rand), dbToAmp(db) * Math.sqrt(3));
}

/** Voiced segments (10 ms frames above -40 dBFS, gaps under 60 ms bridged), in ms from `offsetMs`. */
function voicedSegments(speech, offsetMs) {
  const db = frameDb(speech, 10);
  const segments = [];
  let start = -1;
  let quiet = 0;
  db.forEach((d, i) => {
    if (d > -40) {
      if (start < 0) start = i;
      quiet = 0;
    } else if (start >= 0 && ++quiet > 6) {
      segments.push([offsetMs + start * 10, offsetMs + (i - quiet + 1) * 10]);
      start = -1;
      quiet = 0;
    }
  });
  if (start >= 0) segments.push([offsetMs + start * 10, offsetMs + (db.length - quiet) * 10]);
  return segments;
}

function makeSpeechLoop() {
  const { speech, voice, rate } = synthesizeSpeech();
  scale(speech, dbToAmp(-3) / peak(speech)); // close-talking helmet mic: peaks at -3 dBFS
  const x = noiseFloor(CYCLE_S * SR, prng(1));
  const start = SPEECH_START_S * SR;
  addInto(x, speech, start);
  const startMs = SPEECH_START_S * 1000;
  const endMs = Math.round(startMs + (speech.length / SR) * 1000);
  const segments = voicedSegments(speech, startMs);
  let longestPauseMs = 0;
  for (let i = 1; i < segments.length; i++) longestPauseMs = Math.max(longestPauseMs, segments[i][0] - segments[i - 1][1]);
  const sidecar = {
    file: 'speech-loop.wav',
    sampleRate: SR,
    cycleMs: CYCLE_S * 1000,
    note: 'Chrome loops the file: the window repeats every cycleMs from the moment the fake mic starts.',
    speech: { startMs, endMs, durationMs: endMs - startMs, text: SPEECH_TEXT, voice, rateWpm: rate },
    windowsMs: [[startMs, endMs]],
    voicedSegmentsMs: segments,
    longestPauseMs,
  };
  return { x, sidecar };
}

function makeSilence() {
  return noiseFloor(10 * SR, prng(2));
}

/** Wind buffeting: rumble-heavy noise under a slow random gust envelope with a few hard gusts. */
function makeWind() {
  const seconds = 20;
  const n = seconds * SR;
  const fade = SR / 2;
  const total = n + fade;
  const rand = prng(3);

  // Rumble dominates; some buffeting in the low mids and a little turbulence hiss up top.
  const rumble = biquad(biquad(whiteNoise(total, rand), 'lowpass', 120), 'lowpass', 120);
  const buffet = biquad(whiteNoise(total, rand), 'bandpass', 260, 0.8);
  const hiss = biquad(whiteNoise(total, rand), 'highpass', 1200);
  const mix = new Float64Array(total);
  addInto(mix, rumble, 0, 1 / rms(rumble));
  addInto(mix, buffet, 0, dbToAmp(-14) / rms(buffet));
  addInto(mix, hiss, 0, dbToAmp(-34) / rms(hiss));
  const hp = biquad(mix, 'highpass', 25); // no DC / sub-sonic drift

  // Gust envelope at 100 Hz control rate: smoothed random walk plus a handful of sharp gusts.
  const ctlRate = 100;
  const ctl = new Float64Array(Math.ceil((total / SR) * ctlRate) + 2);
  let walk = 0.5;
  let smooth = 0.5;
  for (let i = 0; i < ctl.length; i++) {
    walk = Math.min(1, Math.max(0, walk + (rand() - 0.5) * 0.12));
    smooth += (walk - smooth) * 0.03;
    ctl[i] = 0.18 + 0.82 * smooth ** 1.5;
  }
  for (let g = 0; g < 6; g++) {
    const at = Math.floor(rand() * (ctl.length - 200));
    for (let i = 0; i < 200 && at + i < ctl.length; i++) {
      const t = i / ctlRate;
      ctl[at + i] += 1.2 * (t < 0.15 ? t / 0.15 : Math.exp(-(t - 0.15) / 0.5));
    }
  }
  for (let i = 0; i < total; i++) {
    const p = (i / SR) * ctlRate;
    const k = Math.floor(p);
    hp[i] *= ctl[k] + (ctl[k + 1] - ctl[k]) * (p - k);
  }

  const x = loopable(hp, n);
  scale(x, dbToAmp(-24) / rms(x));
  return softLimit(x, -2);
}

function makeTone() {
  // 10 s of 440 Hz is exactly 4400 cycles, so the loop point is phase-continuous.
  const n = 10 * SR;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.25 * Math.sin((2 * Math.PI * 440 * i) / SR);
  return x;
}

const midiHz = (m) => 440 * 2 ** ((m - 69) / 12);

function makeMusic() {
  const seconds = 30;
  const n = seconds * SR;
  const x = new Float64Array(n);
  const beat = 0.5; // 120 bpm
  const bar = 4 * beat;
  // C - G - Am - F, as MIDI chord tones.
  const chords = [
    [60, 64, 67],
    [55, 59, 62],
    [57, 60, 64],
    [53, 57, 60],
  ];
  const rand = prng(4);

  const note = (startS, durS, hz, amp, shape, decayS) => {
    const a = Math.floor(startS * SR);
    const len = Math.min(Math.floor(durS * SR), n - a);
    for (let i = 0; i < len; i++) {
      const t = i / SR;
      const ph = 2 * Math.PI * hz * t;
      const osc = shape === 'tri' ? (2 / Math.PI) * Math.asin(Math.sin(ph)) : Math.sin(ph) + 0.3 * Math.sin(2 * ph);
      const attack = Math.min(1, t / (shape === 'tri' ? 0.08 : 0.005));
      const release = Math.min(1, (durS - t) / 0.05);
      const env = decayS ? Math.exp(-t / decayS) : 1;
      x[a + i] += amp * osc * attack * release * env;
    }
  };

  for (let b = 0; b * bar < seconds; b++) {
    const t0 = b * bar;
    const chord = chords[b % chords.length];
    for (const m of chord) {
      note(t0, bar, midiHz(m), 0.06, 'tri', 0); // pad
      note(t0, bar, midiHz(m) * 1.003, 0.04, 'tri', 0); // detuned double
    }
    note(t0, beat * 2, midiHz(chord[0] - 24), 0.22, 'sine', 0.6); // bass on 1
    note(t0 + 2 * beat, beat * 2, midiHz(chord[0] - 24), 0.18, 'sine', 0.6); // and 3
    for (let k = 0; k < 8; k++) {
      const m = chord[k % 3] + 12 + (k >= 6 ? 12 : 0);
      note(t0 + k * (beat / 2), beat / 2, midiHz(m), 0.09, 'sine', 0.18); // arpeggio
    }
    for (let k = 0; k < 4; k++) {
      // kick: pitch drop 120 -> 45 Hz
      const a = Math.floor((t0 + k * beat) * SR);
      let ph = 0;
      for (let i = 0; i < 0.25 * SR && a + i < n; i++) {
        const t = i / SR;
        ph += (2 * Math.PI * (45 + 75 * Math.exp(-t / 0.03))) / SR;
        x[a + i] += 0.5 * Math.sin(ph) * Math.exp(-t / 0.12);
      }
      // hi-hat on the off-beat
      const h = Math.floor((t0 + k * beat + beat / 2) * SR);
      const hat = biquad(whiteNoise(Math.floor(0.08 * SR), rand), 'highpass', 7000);
      for (let i = 0; i < hat.length && h + i < n; i++) x[h + i] += 0.12 * hat[i] * Math.exp(-i / SR / 0.02);
    }
  }
  scale(x, dbToAmp(-16) / rms(x));
  softLimit(x, -1);
  return fadeEdges(x, 20);
}

// ---- verification -----------------------------------------------------------------------------

/** Mean dBFS over [fromS, toS). */
function windowDb(x, fromS, toS) {
  return ampToDb(rms(x, Math.floor(fromS * SR), Math.min(x.length, Math.floor(toS * SR))));
}

const round1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : v === -Infinity ? -999 : v);

/** Checks every fixture against its spec. Returns the measured levels; throws listing every problem. */
export function verifyFixtures(dir = OUT_DIR) {
  const problems = [];
  const report = {};
  const check = (file, ok, msg) => {
    if (!ok) problems.push(`${file}: ${msg}`);
  };
  const load = (file) => {
    const wav = readWav(join(dir, file));
    check(file, wav.rate === SR && wav.channels === 1, `expected 48 kHz mono, got ${wav.channels} ch @ ${wav.rate} Hz`);
    return wav.samples;
  };

  // speech-loop: quiet / speech / quiet, windows as the sidecar says.
  {
    const file = 'speech-loop.wav';
    const x = load(file);
    const side = JSON.parse(readFileSync(join(dir, 'speech-loop.json'), 'utf8'));
    const { startMs, endMs } = side.speech;
    const s = startMs / 1000;
    const e = endMs / 1000;
    const frames100 = frameDb(x, 100);
    const inWindow = frames100.slice(Math.ceil(s * 10), Math.floor(e * 10));
    const loudShare = inWindow.filter((d) => d > -35).length / Math.max(1, inWindow.length);
    const lead = windowDb(x, 0, s - 0.05);
    const speech = windowDb(x, s, e);
    const tail = windowDb(x, e + 0.05, CYCLE_S);
    const quietMax = Math.max(...frames100.slice(0, Math.floor(s * 10) - 1), ...frames100.slice(Math.ceil(e * 10) + 1));
    check(file, x.length === CYCLE_S * SR, `expected ${CYCLE_S} s, got ${(x.length / SR).toFixed(3)} s`);
    check(file, side.cycleMs === CYCLE_S * 1000, `sidecar cycleMs ${side.cycleMs} != ${CYCLE_S * 1000}`);
    check(file, Math.abs((endMs - startMs) / 1000 - SPEECH_TARGET_S) <= SPEECH_TOLERANCE_S, `speech lasts ${(endMs - startMs) / 1000} s`);
    check(file, speech > -30, `speech window RMS ${round1(speech)} dBFS (want > -30)`);
    check(file, loudShare >= 0.6, `only ${(loudShare * 100).toFixed(0)}% of 100 ms frames in the speech window are above -35 dBFS`);
    check(file, quietMax < -55, `a quiet-part 100 ms frame reaches ${round1(quietMax)} dBFS (want < -55)`);
    report[file] = {
      durationS: x.length / SR,
      speechWindowMs: [startMs, endMs],
      leadRmsDbfs: round1(lead),
      speechRmsDbfs: round1(speech),
      tailRmsDbfs: round1(tail),
      speechFramesAboveMinus35: Math.round(loudShare * 100) / 100,
      quietFrameMaxDbfs: round1(quietMax),
    };
  }

  // silence: quiet everywhere.
  {
    const file = 'silence.wav';
    const x = load(file);
    const loudest = Math.max(...frameDb(x, 100));
    check(file, loudest < -60, `loudest 100 ms frame ${round1(loudest)} dBFS (want < -60)`);
    report[file] = { durationS: x.length / SR, rmsDbfs: round1(windowDb(x, 0, x.length / SR)), loudestFrameDbfs: round1(loudest) };
  }

  // wind: realistic level, clearly gusty, energy far below the speech band.
  {
    const file = 'wind.wav';
    const x = load(file);
    const total = ampToDb(rms(x));
    const half = frameDb(x, 500);
    const gustRange = Math.max(...half) - Math.min(...half);
    const speechBand = ampToDb(rms(biquad(biquad(x, 'highpass', 300), 'lowpass', 3400)));
    const low = ampToDb(rms(biquad(x, 'lowpass', 200)));
    check(file, total > -30 && total < -18, `RMS ${round1(total)} dBFS (want -30..-18)`);
    check(file, gustRange >= 8, `500 ms RMS range ${round1(gustRange)} dB (want >= 8 dB of gusting)`);
    check(file, total - speechBand >= 12, `speech band (300-3400 Hz) only ${round1(total - speechBand)} dB below total (want >= 12)`);
    check(file, peak(x) < 1, 'clips');
    report[file] = {
      durationS: x.length / SR,
      rmsDbfs: round1(total),
      peakDbfs: round1(ampToDb(peak(x))),
      below200HzDbfs: round1(low),
      speechBandDbfs: round1(speechBand),
      gustRangeDb: round1(gustRange),
    };
  }

  // tone: steady level at 440 Hz.
  {
    const file = 'tone.wav';
    const x = load(file);
    const frames = frameDb(x, 100);
    const spread = Math.max(...frames) - Math.min(...frames);
    let crossings = 0;
    for (let i = 1; i < x.length; i++) if (x[i - 1] < 0 && x[i] >= 0) crossings++;
    const hz = crossings / (x.length / SR);
    check(file, Math.abs(Math.max(...frames) + 15.05) < 0.5, `level ${round1(Math.max(...frames))} dBFS (want -15)`);
    check(file, spread < 0.2, `level varies by ${round1(spread)} dB`);
    check(file, Math.abs(hz - 440) < 1, `frequency ${hz.toFixed(1)} Hz`);
    report[file] = { durationS: x.length / SR, rmsDbfs: round1(windowDb(x, 0, x.length / SR)), frequencyHz: Math.round(hz * 10) / 10 };
  }

  // music: ~30 s with no gaps.
  {
    const file = 'music.wav';
    const x = load(file);
    const seconds = x.length / SR;
    const perSecond = frameDb(x, 1000);
    check(file, Math.abs(seconds - 30) < 0.5, `duration ${seconds.toFixed(2)} s (want ~30)`);
    check(file, Math.min(...perSecond) > -30 && Math.max(...perSecond) < -8, `1 s RMS ranges ${round1(Math.min(...perSecond))}..${round1(Math.max(...perSecond))} dBFS`);
    report[file] = {
      durationS: seconds,
      rmsDbfs: round1(windowDb(x, 0, seconds)),
      peakDbfs: round1(ampToDb(peak(x))),
      secondRmsRangeDbfs: [round1(Math.min(...perSecond)), round1(Math.max(...perSecond))],
    };
  }

  if (problems.length) throw new Error(`audio fixtures failed verification:\n  - ${problems.join('\n  - ')}`);
  return report;
}

// ---- entry ------------------------------------------------------------------------------------

/** True when every fixture exists and was produced by this generator version. */
export function fixturesUpToDate(dir = OUT_DIR) {
  if (!FILES.every((f) => existsSync(join(dir, f)))) return false;
  try {
    return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).version === GENERATOR_VERSION;
  } catch {
    return false;
  }
}

export function generateFixtures({ force = false } = {}) {
  mkdirSync(OUT_DIR, { recursive: true });
  if (!force && fixturesUpToDate()) return { generated: false, report: verifyFixtures() };
  const speech = makeSpeechLoop();
  writeWav(join(OUT_DIR, 'speech-loop.wav'), speech.x);
  writeFileSync(join(OUT_DIR, 'speech-loop.json'), `${JSON.stringify(speech.sidecar, null, 2)}\n`);
  writeWav(join(OUT_DIR, 'silence.wav'), makeSilence());
  writeWav(join(OUT_DIR, 'wind.wav'), makeWind());
  writeWav(join(OUT_DIR, 'tone.wav'), makeTone());
  writeWav(join(OUT_DIR, 'music.wav'), makeMusic());
  const report = verifyFixtures();
  writeFileSync(
    join(OUT_DIR, 'manifest.json'),
    `${JSON.stringify({ version: GENERATOR_VERSION, generatedAt: new Date().toISOString(), files: report }, null, 2)}\n`,
  );
  return { generated: true, report };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = new Set(process.argv.slice(2));
  try {
    if (args.has('--check')) {
      console.log(JSON.stringify(verifyFixtures(), null, 2));
      console.log('audio fixtures OK');
    } else {
      const { generated, report } = generateFixtures({ force: args.has('--force') });
      console.log(JSON.stringify(report, null, 2));
      console.log(generated ? `audio fixtures written to ${OUT_DIR}` : 'audio fixtures already up to date');
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
