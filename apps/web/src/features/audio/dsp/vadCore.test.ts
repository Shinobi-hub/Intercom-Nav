// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { fixtureNames, loadFixture, resample, type Fixture, type FixtureName } from '../__fixtures__/load';
import { butterworthQs, highpass, lowpass, magnitudeDb } from './biquad';
import { VadCore, onSnrDb, type VadFrame } from './vadCore';

interface Run {
  frameS: number;
  frames: VadFrame[];
}

function run(samples: Float32Array, sampleRate: number, sensitivity = 0.5, blockSize = 128): Run {
  const vad = new VadCore(sampleRate, { sensitivity });
  const frames: VadFrame[] = [];
  for (let i = 0; i < samples.length; i += blockSize) {
    vad.process(samples.subarray(i, i + blockSize), (f) => frames.push({ ...f }));
  }
  return { frameS: vad.frameSize / sampleRate, frames };
}

/** Frame k covers [k*frameS, (k+1)*frameS); a decision is known at the end of its frame. */
const endOf = (r: Run, k: number) => (k + 1) * r.frameS;
const speakingRatio = (r: Run) => r.frames.filter((f) => f.speaking).length / r.frames.length;

function scoreSpeech(r: Run, segments: [number, number][]) {
  const [start] = segments[0]!;
  const end = segments[segments.length - 1]![1];
  const firstOn = r.frames.findIndex((f, k) => f.speaking && endOf(r, k) > start - 0.05);
  let release = -1;
  for (let k = Math.ceil(end / r.frameS); k < r.frames.length; k++) {
    if (!r.frames[k]!.speaking) {
      release = k;
      break;
    }
  }
  let truth = 0;
  let hit = 0;
  let falseFrames = 0;
  r.frames.forEach((f, k) => {
    const t = k * r.frameS;
    if (segments.some(([a, b]) => t >= a && t < b)) {
      truth++;
      if (f.speaking) hit++;
    } else if (f.speaking && !segments.some(([a, b]) => t >= a - 0.05 && t < b + 0.45)) {
      falseFrames++;
    }
  });
  return {
    onsetMs: firstOn < 0 ? Infinity : (endOf(r, firstOn) - start) * 1000,
    releaseMs: release < 0 ? Infinity : (release * r.frameS - end) * 1000,
    coverage: hit / truth,
    falseFrames,
  };
}

function sine(seconds: number, sampleRate: number, hz: number, db: number): Float32Array {
  const a = 10 ** (db / 20);
  return Float32Array.from({ length: Math.round(seconds * sampleRate) }, (_, i) => a * Math.sin((2 * Math.PI * hz * i) / sampleRate));
}

function noise(seconds: number, sampleRate: number, db: number, seed = 1): Float32Array {
  let s = seed;
  const rand = () => (s = (s * 16_807) % 2_147_483_647) / 2_147_483_647;
  const a = 10 ** (db / 20);
  return Float32Array.from({ length: Math.round(seconds * sampleRate) }, () => {
    const u = Math.max(rand(), 1e-12);
    return a * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  });
}

function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const mix = (a: Float32Array, b: Float32Array) => a.map((v, i) => v + (b[i] ?? 0));

/** Vowel-like harmonic complex: every harmonic of f0 below 3.4 kHz at 1/k amplitude, peaking at `db`. */
function harmonics(seconds: number, sampleRate: number, f0: number, db: number): Float32Array {
  const x = Float32Array.from({ length: Math.round(seconds * sampleRate) }, (_, i) => {
    let v = 0;
    for (let k = 1; k * f0 < 3_400; k++) v += Math.sin((2 * Math.PI * k * f0 * i) / sampleRate) / k;
    return v;
  });
  const peak = x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  return x.map((v) => (v / peak) * 10 ** (db / 20));
}

describe('speech-band filters', () => {
  it('uses Butterworth sections', () => {
    const [q1, q2] = butterworthQs(4).sort((a, b) => a - b);
    expect(q1).toBeCloseTo(0.5412, 4);
    expect(q2).toBeCloseTo(1.3066, 4);
    expect(butterworthQs(2)[0]).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('passes 300 Hz - 3.4 kHz and rejects rumble', () => {
    const sr = 48_000;
    const response = (f: number) =>
      butterworthQs(4).reduce((db, q) => db + magnitudeDb(highpass(sr, 300, q), sr, f), 0) +
      magnitudeDb(lowpass(sr, 3_400), sr, f);
    expect(response(300)).toBeCloseTo(-3, 0);
    expect(response(1_000)).toBeGreaterThan(-0.5);
    expect(response(3_400)).toBeCloseTo(-3, 0);
    expect(response(150)).toBeLessThan(-23);
    expect(response(60)).toBeLessThan(-55);
  });
});

describe('VadCore levels', () => {
  it('reports AES17 dBFS in the speech band (a sine reads its peak level)', () => {
    const r = run(sine(0.5, 48_000, 1_000, -20), 48_000);
    expect(r.frames.at(-1)!.levelDb).toBeCloseTo(-20, 0);
    const low = run(sine(0.5, 48_000, 80, -20), 48_000);
    expect(low.frames.at(-1)!.levelDb).toBeLessThan(-60);
  });

  it('handles digital silence and NaN samples without poisoning its state', () => {
    const x = new Float32Array(48_000);
    x[100] = Number.NaN;
    const r = run(concat(x, sine(0.5, 48_000, 1_000, -20)), 48_000);
    for (const f of r.frames) {
      expect(Number.isFinite(f.levelDb)).toBe(true);
      expect(Number.isFinite(f.floorDb)).toBe(true);
    }
    expect(r.frames.at(-1)!.levelDb).toBeCloseTo(-20, 0);
  });

  it('gives identical frames whatever the block size', () => {
    const fx = loadFixture('speech-samantha.wav');
    const a = run(fx.samples, fx.sampleRate, 0.5, 128);
    const b = run(fx.samples, fx.sampleRate, 0.5, 1_000);
    expect(b.frames).toEqual(a.frames);
  });

  it('starts over after reset()', () => {
    const fx = loadFixture('speech-daniel.wav');
    const vad = new VadCore(fx.sampleRate);
    const first: boolean[] = [];
    vad.process(fx.samples, (f) => first.push(f.speaking));
    vad.reset();
    expect(vad.speaking).toBe(false);
    expect(vad.frameCount).toBe(0);
    const second: boolean[] = [];
    vad.process(fx.samples, (f) => second.push(f.speaking));
    expect(second).toEqual(first);
  });
});

const cleanSpeech: FixtureName[] = ['speech-samantha.wav', 'speech-daniel.wav', 'speech-rishi.wav', 'speech-karen.wav'];

describe.each([16_000, 48_000, 44_100])('VadCore on recorded fixtures at %i Hz', (rate) => {
  const at = (fx: Fixture) => (rate === fx.sampleRate ? fx.samples : resample(fx.samples, fx.sampleRate, rate));

  it.each(cleanSpeech)('%s: detects speech within 60 ms and releases within 400 ms', (name) => {
    const fx = loadFixture(name);
    const score = scoreSpeech(run(at(fx), rate), fx.segments);
    expect(score.onsetMs).toBeLessThanOrEqual(60);
    expect(score.releaseMs).toBeLessThanOrEqual(400);
    expect(score.coverage).toBeGreaterThan(0.95);
    expect(score.falseFrames).toBe(0);
  });

  // wind-captured/-received: the e2e wind after WebRTC capture processing and after Opus/DTX.
  it.each(['wind.wav', 'hum.wav', 'silence.wav', 'wind-captured.wav', 'wind-received.wav'] as const)('%s: under 2 percent speaking frames', (name) => {
    const fx = loadFixture(name);
    expect(speakingRatio(run(at(fx), rate))).toBeLessThan(0.02);
  });

  it('still detects speech over moderate wind', () => {
    const fx = loadFixture('speech-wind.wav');
    const score = scoreSpeech(run(at(fx), rate), fx.segments);
    // The utterance opens with an unvoiced /s/ barely above the wind; the voiced part follows.
    expect(score.onsetMs).toBeLessThanOrEqual(200);
    expect(score.releaseMs).toBeLessThanOrEqual(400);
    expect(score.coverage).toBeGreaterThan(0.85);
    expect(score.falseFrames).toBe(0);
  });
});

describe('VadCore behaviour', () => {
  const sr = 48_000;

  it('maps sensitivity to the on-threshold SNR', () => {
    expect(onSnrDb(0)).toBe(18);
    expect(onSnrDb(0.5)).toBe(12);
    expect(onSnrDb(1)).toBe(6);
    expect(onSnrDb(7)).toBe(6);
  });

  it('needs more SNR at lower sensitivity', () => {
    // A 1 kHz burst 8 dB above the in-band noise: enough at sensitivity 1 (6 dB), not at 0.5 (12 dB).
    const bed = noise(3, sr, -50);
    const bedLevel = run(bed, sr).frames.slice(10).reduce((s, f) => s + f.levelDb, 0) / 290;
    const burst = concat(new Float32Array(sr), sine(1, sr, 1_000, bedLevel + 8), new Float32Array(sr));
    const x = mix(bed, burst);
    expect(speakingRatio(run(x, sr, 1))).toBeGreaterThan(0.25);
    expect(speakingRatio(run(x, sr, 0.5))).toBe(0);
  });

  it('needs three consecutive loud frames to start', () => {
    const quiet = noise(1, sr, -70);
    const burst = (s: number) => run(concat(quiet, mix(noise(s, sr, -70), sine(s, sr, 1_000, -20)), quiet), sr);
    expect(burst(0.01).frames.some((f) => f.speaking)).toBe(false);
    expect(burst(0.04).frames.some((f) => f.speaking)).toBe(true);
  });

  it('holds for the 300 ms hangover after speech stops', () => {
    const x = concat(noise(1, sr, -70, 1), mix(noise(0.5, sr, -70, 2), sine(0.5, sr, 700, -20)), noise(1, sr, -70, 3));
    const r = run(x, sr);
    const off = r.frames.findIndex((f, k) => k * r.frameS > 1.5 && !f.speaking);
    expect(off * r.frameS - 1.5).toBeGreaterThan(0.28);
    expect(off * r.frameS - 1.5).toBeLessThan(0.33);
  });

  it('ignores anything quieter than -65 dBFS', () => {
    const x = concat(new Float32Array(sr), sine(1, sr, 1_000, -72), new Float32Array(sr));
    expect(run(x, sr, 1).frames.some((f) => f.speaking)).toBe(false);
  });

  it('does not mistake a slow swell for speech', () => {
    // Broadband noise ramping up 24 dB over 1.5 s, like a passing vehicle or a gust building.
    const n = noise(4, sr, -60);
    for (let i = 0; i < n.length; i++) n[i]! *= 10 ** (Math.min(24, Math.max(0, (i / sr - 1) * 16)) / 20);
    expect(speakingRatio(run(n, sr))).toBeLessThan(0.02);
  });

  it('lets go of a sudden steady noise within a few seconds', () => {
    // A step from mic hiss to loud broadband noise does read as speech at first, but the
    // minimum-statistics floor catches up instead of waiting out the slow rise.
    const x = concat(noise(2, sr, -70, 4), noise(10, sr, -35, 5));
    const r = run(x, sr);
    const speakingS = r.frames.filter((f) => f.speaking).length * r.frameS;
    expect(speakingS).toBeLessThan(3);
    expect(r.frames.slice(-200).some((f) => f.speaking)).toBe(false);
  });

  it('raises its thresholds when low-frequency wind dominates', () => {
    const fx = loadFixture('wind.wav');
    const r = run(fx.samples, fx.sampleRate);
    const median = r.frames.map((f) => f.onDb - f.floorDb).sort((a, b) => a - b)[r.frames.length >> 1]!;
    expect(median).toBeGreaterThan(onSnrDb(0.5) + 3);
    const quiet = run(loadFixture('speech-samantha.wav').samples, 16_000);
    expect(quiet.frames[50]!.onDb - quiet.frames[50]!.floorDb).toBeCloseTo(onSnrDb(0.5), 5);
  });

  it('in wind, only a voiced onset starts speech; in quiet, any sharp onset still does', () => {
    // A sharp broadband burst passes the energy and rise tests like a vowel would, and it is what a
    // gust looks like after the sender's noise suppression. Over wind the onset must also be pitched;
    // without wind the voicing check stays off so consonant-first words keep their fast onset.
    const wind = loadFixture('wind.wav');
    const rate = wind.sampleRate;
    const startS = 3;
    const withBurst = (bed: Float32Array, burst: Float32Array) => run(mix(bed, concat(new Float32Array(startS * rate), burst)), rate);
    const onsetMs = (r: Run) => {
      const k = r.frames.findIndex((f) => f.speaking);
      return k < 0 ? Infinity : (endOf(r, k) - startS) * 1000;
    };
    const hiss = noise(0.5, rate, -20, 7);
    const vowel = harmonics(0.5, rate, 140, -10);

    const hissInWind = withBurst(wind.samples, hiss);
    expect(hissInWind.frames[Math.round(startS / hissInWind.frameS)]!.windy).toBe(true);
    expect(hissInWind.frames.some((f) => f.speaking)).toBe(false);
    expect(onsetMs(withBurst(wind.samples, vowel))).toBeLessThanOrEqual(60);

    const hissInQuiet = withBurst(noise(wind.samples.length / rate, rate, -70, 3), hiss);
    expect(hissInQuiet.frames.some((f) => f.windy)).toBe(false);
    expect(onsetMs(hissInQuiet)).toBeLessThanOrEqual(40);
  });

  it('exposes every fixture', () => {
    expect(fixtureNames).toContain('mic-loop.wav');
    for (const name of fixtureNames) expect(loadFixture(name).sampleRate).toBe(16_000);
  });
});
