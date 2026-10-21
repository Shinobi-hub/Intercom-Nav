/** Messages between the VAD AudioWorklet (vad.worklet.ts) and the main thread. */

export const VAD_PROCESSOR = 'intercom-vad';

/** Levels are posted about this often; speaking transitions are posted immediately. */
export const VAD_LEVEL_INTERVAL_MS = 50;

/**
 * VOX gate envelope generated in the worklet (output 0, audio rate), wired into the gate
 * GainNode's gain param so it opens without a main-thread round trip.
 */
export const GATE_ATTACK_MS = 2;
export const GATE_RELEASE_MS = 25;

export interface VadProcessorOptions {
  sensitivity: number;
}

export interface VadLevels {
  levelDb: number;
  floorDb: number;
  /** Absolute on-threshold, dBFS (for meters). */
  onDb: number;
  speaking: boolean;
  /** Current VOX gate envelope 0..1. */
  gate: number;
}

export type VadMessage =
  | ({ type: 'speaking'; time: number } & VadLevels)
  | ({ type: 'level'; time: number } & VadLevels);

export type VadCommand = { type: 'sensitivity'; value: number } | { type: 'dispose' };
