/**
 * Voice activity detection for one mono stream. Pure DSP, no Web Audio: it runs inside the
 * AudioWorklet, in the main-thread fallback and in the unit tests.
 *
 * Per 10 ms frame:
 *  1. Speech band: 4th-order Butterworth high-pass at 300 Hz + 2nd-order low-pass at 3.4 kHz.
 *     Wind/engine rumble lives mostly below that, voices mostly inside it.
 *  2. Low band (< 250 Hz) energy is measured too: when it towers over the speech band the
 *     stream is dominated by wind buffeting and the thresholds are raised.
 *  3. Adaptive noise floor of the speech band: drops quickly to quieter frames, rises slowly
 *     (even slower while speaking, so a long sentence doesn't become the "floor").
 *  4. Hysteresis thresholds on SNR (derived from sensitivity), onset needs consecutive frames
 *     that also rose quickly (see riseWindowMs), a hangover bridges the gaps between words.
 *  5. Voicing gate, in wind only: onset also needs periodic (pitched) frames, see voicedThreshold.
 *     Energy alone can't tell a vowel from a wind gust once the sender's noise suppression and AGC
 *     have sharpened the gust into a 20-30 dB jump, or Opus DTX switches between comfort noise and
 *     wind. Outside wind the gate stays off, so words that open on a consonant ("Stop", "Heads")
 *     still start within ~30 ms, inside the VOX look-ahead.
 */
import { Biquad, butterworthQs, highpass, lowpass } from './biquad';

export interface VadConfig {
  frameMs: number;
  speechHighpassHz: number;
  speechLowpassHz: number;
  lowBandHz: number;
  floorFallMs: number;
  floorRiseMs: number;
  /** The floor rises this many times slower while speaking. */
  speakingRiseFactor: number;
  /**
   * Minimum statistics: the floor is never kept more than floorWindowMarginDb below the quietest
   * frame of the last floorWindowMs. Speech always dips toward the noise between words, so this
   * never bites on talk, but it stops a sudden steady noise (a truck passing, a tunnel) from
   * reading as minutes of speech while the slow floor catches up.
   */
  floorWindowMs: number;
  floorWindowMarginDb: number;
  /** On-threshold SNR at sensitivity 0; sensitivity 1 lowers it by onSnrRangeDb. */
  onSnrMaxDb: number;
  onSnrRangeDb: number;
  /** Off-threshold = on-threshold - hysteresisDb. */
  hysteresisDb: number;
  /** A frame quieter than this never counts as speech, whatever its SNR. */
  absMinDb: number;
  /**
   * Band powers are smoothed over this time constant before computing the low/speech tilt.
   * Per-frame tilt is useless (voiced frames with a strong fundamental read like wind); smoothed
   * in the power domain, a loud speech onset pulls it down within a frame or two, while wind
   * keeps it steadily high.
   */
  tiltSmoothingMs: number;
  /** Low band may exceed the speech band by this much before the wind penalty kicks in. */
  windTiltDb: number;
  /** Fraction of the excess tilt added to the thresholds. */
  windPenaltyRatio: number;
  onsetFrames: number;
  hangoverMs: number;
  /**
   * Onset also needs the level to clear the quietest frame of this window by the on-threshold SNR.
   * Speech jumps 20-30 dB within a few frames; wind gusts and revving engines swell over hundreds
   * of ms, so they fail this test even when they outrun the slow noise floor.
   */
  riseWindowMs: number;
  /**
   * In wind (the tilt exceeded windTiltDb on a frame without speech in the last windHoldMs), onset
   * also needs onsetVoicedFrames of its frames to be voiced: normalised autocorrelation at a pitch lag
   * (pitchMaxHz..pitchMinHz) of at least voicedThreshold. Vowels score 0.8-1; wind after WebRTC
   * capture processing and Opus stays under ~0.65. Measured over voicingWindowMs of the speech band,
   * decimated to ~voicingRateHz and high-passed again at voicingHighpassHz: the wind that leaks in
   * just above the 300 Hz edge is narrowband and would otherwise look quasi-periodic.
   */
  windHoldMs: number;
  voicedThreshold: number;
  onsetVoicedFrames: number;
  voicingHighpassHz: number;
  voicingRateHz: number;
  voicingWindowMs: number;
  pitchMinHz: number;
  pitchMaxHz: number;
}

export const VAD_CONFIG: Readonly<VadConfig> = {
  frameMs: 10,
  speechHighpassHz: 300,
  speechLowpassHz: 3_400,
  lowBandHz: 250,
  floorFallMs: 100,
  floorRiseMs: 2_500,
  speakingRiseFactor: 4,
  floorWindowMs: 2_000,
  floorWindowMarginDb: 3,
  onSnrMaxDb: 18,
  onSnrRangeDb: 12,
  hysteresisDb: 4,
  absMinDb: -65,
  tiltSmoothingMs: 100,
  windTiltDb: 8,
  windPenaltyRatio: 1,
  onsetFrames: 3,
  hangoverMs: 300,
  riseWindowMs: 100,
  windHoldMs: 5_000,
  voicedThreshold: 0.7,
  onsetVoicedFrames: 1,
  voicingHighpassHz: 700,
  voicingRateHz: 8_000,
  voicingWindowMs: 30,
  pitchMinHz: 70,
  pitchMaxHz: 400,
};

/** Result of one frame. VadCore reuses a single instance: copy it if you need to keep it. */
export interface VadFrame {
  speaking: boolean;
  /** Speech-band level of this frame, dBFS (RMS, AES17: a full-scale sine reads 0 dB). */
  levelDb: number;
  /** Adaptive speech-band noise floor, dBFS. */
  floorDb: number;
  /** levelDb - floorDb. */
  snrDb: number;
  /** Level a frame must reach to count toward speech onset, dBFS (wind penalty included). */
  onDb: number;
  /** Smoothed low-band minus speech-band power, dB. Large and positive in wind. */
  tiltDb: number;
  /** Wind context: onsets currently need voicing (see VadConfig.windHoldMs). */
  windy: boolean;
  /** Periodicity 0..1 (see VadConfig.voicedThreshold); only measured on onset frames in wind, else 0. */
  voicing: number;
}

const MIN_DB = -120;
const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5);
const toDb = (meanSquare: number) => Math.max(MIN_DB, 10 * Math.log10(meanSquare + 1e-12));

/** SNR (dB) a frame needs to start speech at a given sensitivity (0..1). */
export function onSnrDb(sensitivity: number, config: Pick<VadConfig, 'onSnrMaxDb' | 'onSnrRangeDb'> = VAD_CONFIG): number {
  return config.onSnrMaxDb - config.onSnrRangeDb * clamp01(sensitivity);
}

export class VadCore {
  readonly frameSize: number;
  private readonly cfg: VadConfig;
  private readonly speechFilters: [Biquad, Biquad, Biquad];
  private readonly lowFilter: Biquad;
  private readonly fallCoef: number;
  private readonly riseCoef: number;
  private readonly riseSpeakingCoef: number;
  private readonly tiltCoef: number;
  private speechPower = 0;
  private lowPower = 0;
  private readonly hangoverFrames: number;
  /** Ring of the most recent frame levels, for the onset rise test. */
  private readonly recent: Float64Array;
  private recentPos = 0;
  /** Minimum frame level of each ~100 ms block over the last floorWindowMs. */
  private readonly blockMins: Float64Array;
  private readonly framesPerBlock: number;
  private blockMin = Infinity;
  private blockFrames = 0;
  private blockPos = 0;
  private blocksFilled = 0;
  private dcX = 0;
  private dcY = 0;
  private readonly dcR: number;
  /** Voicing analysis: decimated, high-passed speech band in a ring, oldest sample at voicePos. */
  private readonly voiceHp: Biquad;
  private readonly decimation: number;
  private readonly voiceRing: Float64Array;
  private readonly voiceLinear: Float64Array;
  private readonly voiceWindow: number;
  private readonly minLag: number;
  private readonly maxLag: number;
  private readonly windHoldFrames: number;
  private windyFrames = 0;
  private voicePos = 0;
  private voiceFilled = 0;
  private decimSum = 0;
  private decimCount = 0;

  private onSnr: number;
  private pos = 0;
  private speechSum = 0;
  private lowSum = 0;
  private floor = Number.NaN;
  private onsetCount = 0;
  private voicedCount = 0;
  private hangCount = 0;
  private frames = 0;
  private readonly frame: VadFrame = { speaking: false, levelDb: MIN_DB, floorDb: MIN_DB, snrDb: 0, onDb: 0, tiltDb: 0, windy: false, voicing: 0 };

  constructor(
    readonly sampleRate: number,
    opts: { sensitivity?: number; config?: Partial<VadConfig> } = {},
  ) {
    const cfg = { ...VAD_CONFIG, ...opts.config };
    this.cfg = cfg;
    this.frameSize = Math.max(1, Math.round((sampleRate * cfg.frameMs) / 1000));
    const frameS = this.frameSize / sampleRate;
    const coef = (ms: number) => 1 - Math.exp(-frameS / (ms / 1000));
    this.fallCoef = coef(cfg.floorFallMs);
    this.riseCoef = coef(cfg.floorRiseMs);
    this.riseSpeakingCoef = coef(cfg.floorRiseMs * cfg.speakingRiseFactor);
    this.tiltCoef = coef(cfg.tiltSmoothingMs);
    this.hangoverFrames = Math.max(1, Math.round(cfg.hangoverMs / (frameS * 1000)));
    this.windHoldFrames = Math.round(cfg.windHoldMs / (frameS * 1000));
    this.recent = new Float64Array(Math.max(1, Math.round(cfg.riseWindowMs / (frameS * 1000)))).fill(Infinity);
    this.framesPerBlock = Math.max(1, Math.round(0.1 / frameS));
    this.blockMins = new Float64Array(Math.max(1, Math.round(cfg.floorWindowMs / 100)));
    this.onSnr = onSnrDb(opts.sensitivity ?? 0.5, cfg);
    const [q1, q2] = butterworthQs(4) as [number, number];
    this.speechFilters = [
      new Biquad(highpass(sampleRate, cfg.speechHighpassHz, q1)),
      new Biquad(highpass(sampleRate, cfg.speechHighpassHz, q2)),
      new Biquad(lowpass(sampleRate, cfg.speechLowpassHz)),
    ];
    this.lowFilter = new Biquad(lowpass(sampleRate, cfg.lowBandHz));
    // DC blocker for the low band so a mic's DC offset doesn't read as wind.
    this.dcR = 1 - (2 * Math.PI * 20) / sampleRate;
    // Box-car decimation (the speech band's 3.4 kHz low-pass is the anti-alias filter).
    this.decimation = Math.max(1, Math.round(sampleRate / cfg.voicingRateHz));
    const voiceRate = sampleRate / this.decimation;
    this.voiceHp = new Biquad(highpass(voiceRate, cfg.voicingHighpassHz, Math.SQRT1_2));
    this.voiceWindow = Math.max(1, Math.round((voiceRate * cfg.voicingWindowMs) / 1000));
    this.minLag = Math.max(1, Math.floor(voiceRate / cfg.pitchMaxHz));
    this.maxLag = Math.max(this.minLag, Math.ceil(voiceRate / cfg.pitchMinHz));
    this.voiceRing = new Float64Array(this.voiceWindow + this.maxLag);
    this.voiceLinear = new Float64Array(this.voiceRing.length);
  }

  get speaking(): boolean {
    return this.frame.speaking;
  }

  /** The most recent frame (same object every time). */
  get lastFrame(): Readonly<VadFrame> {
    return this.frame;
  }

  /** Frames processed since construction or reset. */
  get frameCount(): number {
    return this.frames;
  }

  setSensitivity(sensitivity: number): void {
    this.onSnr = onSnrDb(sensitivity, this.cfg);
  }

  /**
   * Feed any number of samples. `onFrame` runs once per completed frame, with a frame object that
   * is reused, so read it inside the callback.
   */
  process(input: ArrayLike<number>, onFrame?: (frame: Readonly<VadFrame>) => void): void {
    const [hp1, hp2, lp] = this.speechFilters;
    const low = this.lowFilter;
    const r = this.dcR;
    for (let i = 0; i < input.length; i++) {
      let x = input[i]!;
      if (x !== x) x = 0; // NaN guard: one bad sample must not poison the filter states forever
      const s = lp.process(hp2.process(hp1.process(x)));
      this.speechSum += s * s;
      this.decimSum += s;
      if (++this.decimCount === this.decimation) {
        this.voiceRing[this.voicePos] = this.voiceHp.process(this.decimSum / this.decimation);
        if (++this.voicePos === this.voiceRing.length) this.voicePos = 0;
        if (this.voiceFilled < this.voiceRing.length) this.voiceFilled++;
        this.decimSum = 0;
        this.decimCount = 0;
      }
      this.dcY = x - this.dcX + r * this.dcY;
      this.dcX = x;
      const l = low.process(this.dcY);
      this.lowSum += l * l;
      if (++this.pos === this.frameSize) {
        this.endFrame();
        onFrame?.(this.frame);
      }
    }
  }

  reset(): void {
    for (const f of this.speechFilters) f.reset();
    this.lowFilter.reset();
    this.voiceHp.reset();
    this.voiceRing.fill(0);
    this.voicePos = this.voiceFilled = this.decimCount = 0;
    this.decimSum = 0;
    this.recent.fill(Infinity);
    this.recentPos = 0;
    this.blockMin = Infinity;
    this.blockFrames = this.blockPos = this.blocksFilled = 0;
    this.dcX = this.dcY = 0;
    this.pos = 0;
    this.speechSum = this.lowSum = 0;
    this.floor = Number.NaN;
    this.speechPower = this.lowPower = 0;
    this.onsetCount = this.voicedCount = this.hangCount = this.frames = this.windyFrames = 0;
    Object.assign(this.frame, { speaking: false, levelDb: MIN_DB, floorDb: MIN_DB, snrDb: 0, onDb: 0, tiltDb: 0, windy: false, voicing: 0 });
  }

  private endFrame(): void {
    const cfg = this.cfg;
    // Factor 2: AES17 dBFS, where a full-scale sine reads 0 dB.
    const speechMs = (2 * this.speechSum) / this.frameSize;
    const lowMs = (2 * this.lowSum) / this.frameSize;
    const level = toDb(speechMs);
    this.speechSum = this.lowSum = 0;
    if (this.frames === 0) {
      this.speechPower = speechMs;
      this.lowPower = lowMs;
    } else {
      this.speechPower += this.tiltCoef * (speechMs - this.speechPower);
      this.lowPower += this.tiltCoef * (lowMs - this.lowPower);
    }
    this.pos = 0;
    this.frames++;
    if (this.frames % 16 === 0) {
      for (const f of this.speechFilters) f.flushDenormals();
      this.lowFilter.flushDenormals();
      this.voiceHp.flushDenormals();
      if (Math.abs(this.dcY) < 1e-30) this.dcY = 0;
    }

    if (Number.isNaN(this.floor)) this.floor = level;
    const floor = this.floor;
    const tilt = toDb(this.lowPower) - toDb(this.speechPower);
    const penalty = tilt > cfg.windTiltDb ? (tilt - cfg.windTiltDb) * cfg.windPenaltyRatio : 0;
    const onDb = Math.max(floor + this.onSnr + penalty, cfg.absMinDb);
    const offDb = Math.max(floor + this.onSnr + penalty - cfg.hysteresisDb, cfg.absMinDb - cfg.hysteresisDb);

    let recentMin = Infinity;
    for (let i = 0; i < this.recent.length; i++) if (this.recent[i]! < recentMin) recentMin = this.recent[i]!;
    const rose = recentMin === Infinity || level >= recentMin + this.onSnr;
    this.recent[this.recentPos] = level;
    this.recentPos = (this.recentPos + 1) % this.recent.length;

    const f = this.frame;
    // Wind context comes from frames without speech only, so a deep voice can't switch the gate on.
    if (!f.speaking && penalty > 0) this.windyFrames = this.windHoldFrames;
    else if (this.windyFrames > 0) this.windyFrames--;
    const windy = this.windyFrames > 0;
    f.voicing = 0;
    if (!f.speaking) {
      if (level >= onDb && rose) {
        this.onsetCount++;
        if (windy) {
          f.voicing = this.measureVoicing();
          if (f.voicing >= cfg.voicedThreshold) this.voicedCount++;
        }
        if (this.onsetCount >= cfg.onsetFrames && (!windy || this.voicedCount >= cfg.onsetVoicedFrames)) {
          f.speaking = true;
          this.hangCount = 0;
        }
      } else {
        this.onsetCount = this.voicedCount = 0;
      }
    } else if (level >= offDb) {
      this.hangCount = 0;
    } else if (++this.hangCount >= this.hangoverFrames) {
      f.speaking = false;
      this.onsetCount = this.voicedCount = 0;
    }

    const coef = level < floor ? this.fallCoef : f.speaking ? this.riseSpeakingCoef : this.riseCoef;
    this.floor = Math.max(floor + coef * (level - floor), this.windowMinimum(level) - cfg.floorWindowMarginDb);

    f.levelDb = level;
    f.floorDb = floor;
    f.snrDb = level - floor;
    f.onDb = onDb;
    f.tiltDb = tilt;
    f.windy = windy;
  }

  /**
   * Highest normalised autocorrelation of the last voicingWindowMs against itself one pitch period
   * earlier, over all pitch lags. 0 until the ring has filled.
   */
  private measureVoicing(): number {
    const ring = this.voiceRing;
    const len = ring.length;
    if (this.voiceFilled < len) return 0;
    const x = this.voiceLinear;
    for (let j = 0, p = this.voicePos; j < len; j++) {
      x[j] = ring[p]!;
      if (++p === len) p = 0;
    }
    const start = len - this.voiceWindow;
    let e0 = 0;
    for (let j = start; j < len; j++) e0 += x[j]! * x[j]!;
    if (!(e0 > 0)) return 0;
    // Energy of the lagged window, slid one sample further back per lag.
    let e1 = 0;
    for (let j = start - this.minLag; j < len - this.minLag; j++) e1 += x[j]! * x[j]!;
    let best = 0;
    for (let lag = this.minLag; lag <= this.maxLag; lag++) {
      let c = 0;
      for (let j = start; j < len; j++) c += x[j]! * x[j - lag]!;
      if (c > 0 && e1 > 0) best = Math.max(best, c / Math.sqrt(e0 * e1));
      if (lag < this.maxLag) {
        const add = x[start - lag - 1]!;
        const drop = x[len - lag - 1]!;
        e1 += add * add - drop * drop;
      }
    }
    return Math.min(1, best);
  }

  /** Tracks per-block minima; returns the window minimum once a full window has been seen. */
  private windowMinimum(level: number): number {
    if (level < this.blockMin) this.blockMin = level;
    if (++this.blockFrames === this.framesPerBlock) {
      this.blockMins[this.blockPos] = this.blockMin;
      this.blockPos = (this.blockPos + 1) % this.blockMins.length;
      this.blocksFilled = Math.min(this.blocksFilled + 1, this.blockMins.length);
      this.blockMin = Infinity;
      this.blockFrames = 0;
    }
    if (this.blocksFilled < this.blockMins.length) return -Infinity;
    let min = Infinity;
    for (let i = 0; i < this.blockMins.length; i++) if (this.blockMins[i]! < min) min = this.blockMins[i]!;
    return min;
  }
}
