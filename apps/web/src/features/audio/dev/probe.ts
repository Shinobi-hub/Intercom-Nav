/**
 * Measurement helpers for the dev harness and the browser verification script: a high-rate
 * sampler of the engine's state and signal taps, plus offline renders of the alert sounds.
 */
import type { RiderId } from '@intercom/shared';
import { CHIMES, startSirenVoice, scheduleNotes, lengthOf } from '../alerts/tones';
import type { AudioEngine } from '../engine/audioEngine';
import { encodeWav } from '../dsp/wav';

export interface ProbeSample {
  /** performance.now() */
  t: number;
  /** AudioContext time */
  ctxTime: number;
  /** RMS of the last ~3 ms at the mic input, dBFS (the reference for speech onset). */
  micDb: number;
  /** RMS of the music after the duck gain, dBFS. */
  musicDb: number;
  duckGain: number;
  voxGate: number;
  speaking: Record<RiderId | 'self', boolean>;
}

function rmsDb(buf: Float32Array<ArrayBuffer>, last: number): number {
  let s = 0;
  const from = Math.max(0, buf.length - last);
  for (let i = from; i < buf.length; i++) s += buf[i]! * buf[i]!;
  return 10 * Math.log10((2 * s) / (buf.length - from) + 1e-12);
}

export class Probe {
  samples: ProbeSample[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private micTap: AnalyserNode | null = null;
  private musicTap: AnalyserNode | null = null;
  private readonly micBuf = new Float32Array(256);
  private readonly musicBuf = new Float32Array(2048);

  constructor(private readonly engine: AudioEngine) {}

  start(maxSamples = 10_000): void {
    this.stop();
    const g = this.engine.debugGraph;
    if (!g) throw new Error('start audio first');
    this.micTap = g.ctx.createAnalyser();
    this.micTap.fftSize = this.micBuf.length;
    g.micIn.connect(this.micTap);
    this.musicTap = g.ctx.createAnalyser();
    this.musicTap.fftSize = this.musicBuf.length;
    g.duck.connect(this.musicTap);
    this.samples = [];
    const debug = window.__intercom?.audio;
    this.timer = setInterval(() => {
      if (!this.micTap || !this.musicTap || !debug) return;
      this.micTap.getFloatTimeDomainData(this.micBuf);
      this.musicTap.getFloatTimeDomainData(this.musicBuf);
      const vad = debug.vad();
      this.samples.push({
        t: performance.now(),
        ctxTime: g.ctx.currentTime,
        micDb: rmsDb(this.micBuf, 128),
        musicDb: rmsDb(this.musicBuf, 1024),
        duckGain: debug.duckGain(),
        voxGate: debug.voxGate(),
        speaking: Object.fromEntries(Object.entries(vad).map(([k, v]) => [k, v.speaking])),
      });
      if (this.samples.length > maxSamples) this.samples.splice(0, this.samples.length - maxSamples);
    }, 4);
  }

  stop(): ProbeSample[] {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.micTap?.disconnect();
    this.musicTap?.disconnect();
    this.micTap = this.musicTap = null;
    return this.samples;
  }
}

/** Peak (dBFS) of the siren and each chime, rendered offline at 48 kHz. */
export async function measureAlertPeaks(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const render = async (seconds: number, play: (ctx: OfflineAudioContext) => void) => {
    const ctx = new OfflineAudioContext(1, Math.ceil(seconds * 48_000), 48_000);
    play(ctx);
    const buf = await ctx.startRendering();
    const data = buf.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]!));
    return Math.round(20 * Math.log10(peak + 1e-12) * 10) / 10;
  };
  out.siren = await render(2, (ctx) => void startSirenVoice(ctx, ctx.destination, 0));
  for (const [kind, notes] of Object.entries(CHIMES)) {
    out[kind] = await render(lengthOf(notes) + 0.1, (ctx) => scheduleNotes(ctx, ctx.destination, notes, 0));
  }
  return out;
}

/** Frequency of the siren over time (zero-crossing estimate per 50 ms), to check the two-tone pattern. */
export async function sirenPitchTrack(): Promise<number[]> {
  const ctx = new OfflineAudioContext(1, 48_000 * 2, 48_000);
  startSirenVoice(ctx, ctx.destination, 0);
  const data = (await ctx.startRendering()).getChannelData(0);
  const hop = 2_400;
  const track: number[] = [];
  for (let i = 0; i + hop <= data.length; i += hop) {
    let crossings = 0;
    for (let k = i + 1; k < i + hop; k++) if (data[k - 1]! < 0 && data[k]! >= 0) crossings++;
    track.push(Math.round((crossings * 48_000) / hop));
  }
  return track;
}

/** A steady two-tone "music" track for ducking measurements. */
export function testToneFile(seconds = 12, sampleRate = 22_050): File {
  const x = new Float32Array(seconds * sampleRate);
  for (let i = 0; i < x.length; i++) {
    const t = i / sampleRate;
    x[i] = 0.25 * Math.sin(2 * Math.PI * 440 * t) + 0.12 * Math.sin(2 * Math.PI * 660 * t);
  }
  return new File([encodeWav(x, sampleRate)], 'Test tone.wav', { type: 'audio/wav' });
}
