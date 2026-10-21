/**
 * Second-order IIR sections from the RBJ Audio EQ Cookbook, run in transposed direct form II.
 * Pure math: shared by the VAD (main thread fallback and AudioWorklet) and the tests.
 */

export interface BiquadCoefficients {
  b0: number;
  b1: number;
  b2: number;
  /** Feedback coefficients, already normalised by a0. */
  a1: number;
  a2: number;
}

function design(type: 'lowpass' | 'highpass', sampleRate: number, f0: number, q: number): BiquadCoefficients {
  const w = (2 * Math.PI * Math.min(f0, sampleRate * 0.49)) / sampleRate;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  const b1 = type === 'lowpass' ? 1 - cos : -(1 + cos);
  const b0 = type === 'lowpass' ? (1 - cos) / 2 : (1 + cos) / 2;
  return { b0: b0 / a0, b1: b1 / a0, b2: b0 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 };
}

export const lowpass = (sampleRate: number, f0: number, q = Math.SQRT1_2) => design('lowpass', sampleRate, f0, q);
export const highpass = (sampleRate: number, f0: number, q = Math.SQRT1_2) => design('highpass', sampleRate, f0, q);

/** Q of each biquad in an even-order Butterworth cascade (order 4 -> [0.541, 1.307]). */
export function butterworthQs(order: number): number[] {
  if (order < 2 || order % 2 !== 0) throw new Error('order must be even and >= 2');
  const qs: number[] = [];
  for (let k = 0; k < order / 2; k++) qs.push(1 / (2 * Math.sin(((2 * k + 1) * Math.PI) / (2 * order))));
  return qs;
}

export class Biquad {
  private z1 = 0;
  private z2 = 0;

  constructor(private readonly c: BiquadCoefficients) {}

  process(x: number): number {
    const c = this.c;
    const y = c.b0 * x + this.z1;
    this.z1 = c.b1 * x - c.a1 * y + this.z2;
    this.z2 = c.b2 * x - c.a2 * y;
    return y;
  }

  /** Zero states that have decayed to denormal range (they make some CPUs crawl on silence). */
  flushDenormals(): void {
    if (Math.abs(this.z1) < 1e-30) this.z1 = 0;
    if (Math.abs(this.z2) < 1e-30) this.z2 = 0;
  }

  reset(): void {
    this.z1 = 0;
    this.z2 = 0;
  }
}

/** Magnitude response in dB at `f` Hz (used by tests to check the filter design). */
export function magnitudeDb(c: BiquadCoefficients, sampleRate: number, f: number): number {
  const w = (2 * Math.PI * f) / sampleRate;
  const re = (a: number, b: number, d: number) => a + b * Math.cos(w) + d * Math.cos(2 * w);
  const im = (b: number, d: number) => -(b * Math.sin(w) + d * Math.sin(2 * w));
  const nr = re(c.b0, c.b1, c.b2);
  const ni = im(c.b1, c.b2);
  const dr = re(1, c.a1, c.a2);
  const di = im(c.a1, c.a2);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}
