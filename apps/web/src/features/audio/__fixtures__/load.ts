/**
 * Test fixtures (see generate.mjs), bundled as base64 data URLs so tests can load
 * them in any environment without filesystem access.
 */
import meta from './fixtures.json';
import { bytesFromDataUrl, decodeWav } from '../dsp/wav';

const files = import.meta.glob<string>('./*.wav', { query: '?inline', import: 'default', eager: true });

export type FixtureName = keyof typeof meta.fixtures;

export interface Fixture {
  name: FixtureName;
  sampleRate: number;
  samples: Float32Array;
  kind: 'speech' | 'noise';
  /** Where the speech is, in seconds. */
  segments: [number, number][];
}

export function loadFixture(name: FixtureName): Fixture {
  const url = files[`./${name}`];
  if (!url) throw new Error(`fixture ${name} is missing; run generate.mjs`);
  const { sampleRate, channels } = decodeWav(bytesFromDataUrl(url));
  const info = meta.fixtures[name];
  return {
    name,
    sampleRate,
    samples: channels[0]!,
    kind: info.kind as Fixture['kind'],
    segments: info.segments as [number, number][],
  };
}

export const fixtureNames = Object.keys(meta.fixtures) as FixtureName[];

/** Linear-interpolation resampler, good enough to replay 16 kHz fixtures at device rates. */
export function resample(samples: Float32Array, from: number, to: number): Float32Array {
  const out = new Float32Array(Math.floor((samples.length * to) / from));
  const step = from / to;
  for (let i = 0; i < out.length; i++) {
    const p = i * step;
    const k = Math.floor(p);
    const a = samples[k] ?? 0;
    const b = samples[k + 1] ?? a;
    out[i] = a + (b - a) * (p - k);
  }
  return out;
}
