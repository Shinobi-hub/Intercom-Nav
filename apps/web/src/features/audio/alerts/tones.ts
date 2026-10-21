/**
 * Synthesized earcons and the SOS siren, as data plus a scheduler. No audio assets: everything is
 * oscillators and envelopes, so it works offline and costs nothing to ship.
 */
import type { ChimeKind } from '../../../core/services';

export interface Note {
  /** Start, seconds after the chime is triggered. */
  at: number;
  freq: number;
  /** Seconds until the note has decayed to silence. */
  dur: number;
  type: OscillatorType;
  /** Peak linear gain. */
  gain: number;
  /** Attack time, seconds. */
  attack: number;
  /** Optional low-pass to soften bright waveforms. */
  lowpassHz?: number;
}

const C5 = 523.25;
const D5 = 587.33;
const E5 = 659.25;
const G5 = 783.99;
const B5 = 987.77;
const A6 = 1_760;

const soft = (at: number, freq: number, dur = 0.32, gain = 0.32): Note => ({ at, freq, dur, type: 'sine', gain, attack: 0.012 });

export const CHIMES: Record<ChimeKind, Note[]> = {
  // Doorbell-like "ding-dong": friendly, unmistakably not the siren.
  break: [soft(0, E5, 0.45), soft(0.22, C5, 0.6)],
  join: [soft(0, C5, 0.22, 0.28), soft(0.09, E5, 0.22, 0.28), soft(0.18, G5, 0.35, 0.28)],
  leave: [soft(0, G5, 0.22, 0.28), soft(0.09, E5, 0.22, 0.28), soft(0.18, C5, 0.35, 0.28)],
  sent: [0, 0.08, 0.16].map((at) => ({ at, freq: 1_850, dur: 0.035, type: 'triangle' as const, gain: 0.22, attack: 0.002 })),
  route: [soft(0, D5, 0.25, 0.28), soft(0.12, G5, 0.25, 0.28), soft(0.24, B5, 0.5, 0.3)],
  // Bell: a fundamental plus an inharmonic partial, long decay.
  responder: [
    { at: 0, freq: A6, dur: 0.9, type: 'sine', gain: 0.3, attack: 0.004 },
    { at: 0, freq: A6 * 2.76, dur: 0.35, type: 'sine', gain: 0.08, attack: 0.002 },
  ],
  error: [
    { at: 0, freq: 155, dur: 0.32, type: 'sawtooth', gain: 0.2, attack: 0.01, lowpassHz: 900 },
    { at: 0, freq: 158, dur: 0.32, type: 'square', gain: 0.1, attack: 0.01, lowpassHz: 900 },
  ],
};

export const CLICK: Note[] = [{ at: 0, freq: 1_400, dur: 0.018, type: 'triangle', gain: 0.18, attack: 0.001 }];

/** The siren alternates between these two pitches, each held for SIREN_HALF_PERIOD_S. */
export const SIREN_HIGH_HZ = 960;
export const SIREN_LOW_HZ = 770;
export const SIREN_HALF_PERIOD_S = 0.4;
/** Peak gains of the two voices (sawtooth + slightly detuned square), chosen for ~-2 dBFS peaks. */
export const SIREN_SAW_GAIN = 0.42;
export const SIREN_SQUARE_GAIN = 0.24;
export const SIREN_LOWPASS_HZ = 2_600;

/** Total duration of a note list, seconds. */
export function lengthOf(notes: Note[]): number {
  return notes.reduce((m, n) => Math.max(m, n.at + n.dur), 0);
}

/** Upper bound of the summed peak gain at any instant (notes overlapping in time). */
export function peakGain(notes: Note[]): number {
  let peak = 0;
  for (const n of notes) {
    const overlapping = notes.filter((o) => o.at < n.at + n.dur && n.at < o.at + o.dur);
    peak = Math.max(peak, overlapping.reduce((s, o) => s + o.gain, 0));
  }
  return peak;
}

/**
 * Schedules `notes` on `dest` starting at `when`. Each note is its own oscillator and gain
 * envelope (attack, then exponential decay), cleaned up when it ends.
 */
export function scheduleNotes(ctx: BaseAudioContext, dest: AudioNode, notes: Note[], when = ctx.currentTime): void {
  for (const n of notes) {
    const t = when + n.at;
    const osc = ctx.createOscillator();
    osc.type = n.type;
    osc.frequency.value = n.freq;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(n.gain, t + n.attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t + n.dur);
    let tail: AudioNode = osc;
    let filter: BiquadFilterNode | null = null;
    if (n.lowpassHz) {
      filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = n.lowpassHz;
      osc.connect(filter);
      tail = filter;
    }
    tail.connect(env);
    env.connect(dest);
    osc.start(t);
    osc.stop(t + n.dur + 0.02);
    osc.onended = () => {
      osc.disconnect();
      filter?.disconnect();
      env.disconnect();
    };
  }
}

export interface SirenVoice {
  stop(fadeS?: number): void;
}

/**
 * Two-tone siren: a 1.25 Hz square LFO swings both oscillators between the high and low pitch, so
 * the alternation is sample-accurate and needs no JS timers while it loops.
 */
export function startSirenVoice(ctx: BaseAudioContext, dest: AudioNode, when = ctx.currentTime): SirenVoice {
  const center = (SIREN_HIGH_HZ + SIREN_LOW_HZ) / 2;
  const swing = (SIREN_HIGH_HZ - SIREN_LOW_HZ) / 2;
  const lfo = ctx.createOscillator();
  lfo.type = 'square';
  lfo.frequency.value = 1 / (2 * SIREN_HALF_PERIOD_S);
  const depth = ctx.createGain();
  depth.gain.value = swing;
  lfo.connect(depth);

  const saw = ctx.createOscillator();
  saw.type = 'sawtooth';
  const square = ctx.createOscillator();
  square.type = 'square';
  square.detune.value = 8;
  const mixSaw = ctx.createGain();
  mixSaw.gain.value = SIREN_SAW_GAIN;
  const mixSquare = ctx.createGain();
  mixSquare.gain.value = SIREN_SQUARE_GAIN;
  const lowpass = ctx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = SIREN_LOWPASS_HZ;
  lowpass.Q.value = 0.7;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, when);
  env.gain.linearRampToValueAtTime(1, when + 0.03);

  for (const osc of [saw, square]) {
    osc.frequency.value = center;
    depth.connect(osc.frequency);
  }
  saw.connect(mixSaw).connect(lowpass);
  square.connect(mixSquare).connect(lowpass);
  lowpass.connect(env).connect(dest);
  const oscillators = [lfo, saw, square];
  for (const o of oscillators) o.start(when);

  let stopped = false;
  return {
    stop(fadeS = 0.05) {
      if (stopped) return;
      stopped = true;
      const t = ctx.currentTime;
      env.gain.cancelScheduledValues(t);
      env.gain.setTargetAtTime(0, t, fadeS / 3);
      for (const o of oscillators) o.stop(t + fadeS * 2);
      saw.onended = () => {
        for (const n of [lfo, depth, saw, square, mixSaw, mixSquare, lowpass, env]) n.disconnect();
      };
    },
  };
}
