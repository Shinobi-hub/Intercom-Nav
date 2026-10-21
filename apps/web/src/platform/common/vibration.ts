/** One "motor on" stretch of a vibration pattern, `at` ms after the pattern starts. */
export interface VibrationSegment {
  at: number;
  duration: number;
}

/** Longest single pulse or pause we honour; longer values are almost certainly a bug. */
const MAX_STEP_MS = 5_000;
/** Same cap Chromium applies to navigator.vibrate patterns. */
const MAX_STEPS = 32;

function clampStep(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.min(Math.round(v), MAX_STEP_MS);
}

/**
 * Turns a navigator.vibrate-style pattern (on, off, on, ...) into the pulses to play.
 * `0`, `[]` or an all-zero pattern yields no segments, which means "stop vibrating".
 */
export function toVibrationSegments(pattern: number | readonly number[]): VibrationSegment[] {
  const steps = typeof pattern === 'number' ? [pattern] : pattern.slice(0, MAX_STEPS);
  const segments: VibrationSegment[] = [];
  let t = 0;
  steps.forEach((raw, i) => {
    const ms = clampStep(raw);
    if (i % 2 === 0 && ms > 0) segments.push({ at: t, duration: ms });
    t += ms;
  });
  return segments;
}
