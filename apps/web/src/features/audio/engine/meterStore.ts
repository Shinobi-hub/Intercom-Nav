/**
 * Fast-changing mic meter data for MicLevelMeter (~20 Hz). Kept out of useLocalStore so the
 * meter doesn't re-render every other subscriber of the audio slice.
 */
import { create } from 'zustand';

export interface MicMeter {
  /** Speech-band level, dBFS; null while the mic is off. */
  levelDb: number | null;
  /** Level that starts speech detection right now (noise floor + threshold), dBFS. */
  onDb: number | null;
  floorDb: number | null;
  speaking: boolean;
  /** Why the mic isn't live, if it failed. */
  error: string | null;
}

export const useMicMeter = create<MicMeter>()(() => ({ levelDb: null, onDb: null, floorDb: null, speaking: false, error: null }));
