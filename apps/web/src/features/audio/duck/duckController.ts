/**
 * Music ducking envelope. Pure state machine: it decides *what* the duck gain should do and when,
 * and hands each ramp to `apply`, which the engine turns into cancelScheduledValues +
 * setTargetAtTime on the dedicated duck GainNode (separate from the user's music volume).
 *
 *   speech starts    -> attack to duckLevel (~95% there after attackMs)
 *   speech stops     -> hold at duckLevel for holdMs (bridges pauses between sentences)
 *   hold expires     -> release to 1 (~95% there after releaseMs)
 *   SOS              -> 0 straight away, whatever speech does; afterwards back to where speech says
 */
import { TIMING } from '@intercom/shared';

export interface DuckTiming {
  attackMs: number;
  holdMs: number;
  releaseMs: number;
}

export const DUCK_TIMING: Readonly<DuckTiming> = {
  attackMs: TIMING.duckAttackMs,
  holdMs: TIMING.duckHoldMs,
  releaseMs: TIMING.duckReleaseMs,
};

/** setTargetAtTime reaches 95% after 3 time constants. */
export const timeConstantFor = (ms: number) => ms / 3 / 1000;

/** Short enough to be "immediate", long enough not to click. */
export const MUTE_TIME_CONSTANT_S = 0.004;

/** One instruction for the duck gain: head for `target` with this setTargetAtTime time constant. */
export interface DuckRamp {
  target: number;
  timeConstantS: number;
}

/** Timer seam so tests can drive the controller with a fake clock. */
export interface DuckClock {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: DuckClock = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export type DuckPhase = 'idle' | 'ducked' | 'holding' | 'muted';

export interface DuckControllerOptions {
  duckLevel: number;
  apply: (ramp: DuckRamp) => void;
  /** Fires when `active` (ducked for speech, including the hold) changes. */
  onActiveChange?: (active: boolean) => void;
  timing?: DuckTiming;
  clock?: DuckClock;
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1);

export class DuckController {
  private readonly timing: DuckTiming;
  private readonly clock: DuckClock;
  private duckLevel: number;
  private speech = false;
  private sos = false;
  private holding = false;
  private holdTimer: unknown = null;
  private wasActive = false;
  private lastTarget = 1;

  constructor(private readonly opts: DuckControllerOptions) {
    this.timing = opts.timing ?? DUCK_TIMING;
    this.clock = opts.clock ?? realClock;
    this.duckLevel = clamp01(opts.duckLevel);
  }

  /** Ducked for speech right now (speaking, or inside the hold after it). */
  get active(): boolean {
    return this.speech || this.holding;
  }

  get phase(): DuckPhase {
    if (this.sos) return 'muted';
    if (this.speech) return 'ducked';
    return this.holding ? 'holding' : 'idle';
  }

  /** The gain the envelope is heading for. */
  get target(): number {
    return this.lastTarget;
  }

  setSpeech(active: boolean): void {
    if (active === this.speech) return;
    this.speech = active;
    if (active) {
      this.cancelHold();
      this.holding = false;
      this.ramp(this.duckLevel, timeConstantFor(this.timing.attackMs));
    } else {
      this.holding = true;
      this.holdTimer = this.clock.setTimeout(() => {
        this.holdTimer = null;
        this.holding = false;
        this.ramp(1, timeConstantFor(this.timing.releaseMs));
        this.notify();
      }, this.timing.holdMs);
    }
    this.notify();
  }

  setSos(active: boolean): void {
    if (active === this.sos) return;
    this.sos = active;
    if (active) {
      this.ramp(0, MUTE_TIME_CONSTANT_S);
    } else {
      // Fade back in to wherever speech says the music should be.
      this.ramp(this.active ? this.duckLevel : 1, timeConstantFor(this.timing.releaseMs));
    }
  }

  setDuckLevel(level: number): void {
    const next = clamp01(level);
    if (next === this.duckLevel) return;
    this.duckLevel = next;
    if (this.active) this.ramp(next, timeConstantFor(this.timing.attackMs));
  }

  dispose(): void {
    this.cancelHold();
  }

  private ramp(target: number, timeConstantS: number): void {
    // SOS owns the gain until it ends; speech changes are remembered and applied afterwards.
    if (this.sos && target !== 0) return;
    this.lastTarget = target;
    this.opts.apply({ target, timeConstantS });
  }

  private cancelHold(): void {
    if (this.holdTimer !== null) this.clock.clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }

  private notify(): void {
    const active = this.active;
    if (active === this.wasActive) return;
    this.wasActive = active;
    this.opts.onActiveChange?.(active);
  }
}

/**
 * Value of an AudioParam driven only by setTargetAtTime events (each cancelling the ones after it),
 * evaluated at `t`. Mirrors the Web Audio formula; used by tests and the debug readout model.
 */
export function envelopeAt(events: { at: number; target: number; timeConstantS: number }[], t: number, initial = 1): number {
  let value = initial;
  let from = 0;
  let current: { target: number; timeConstantS: number } | null = null;
  const advance = (until: number) => {
    if (!current) return;
    value = current.timeConstantS <= 0 ? current.target : current.target + (value - current.target) * Math.exp(-(until - from) / current.timeConstantS);
  };
  for (const e of events) {
    if (e.at > t) break;
    advance(e.at);
    from = e.at;
    current = e;
  }
  advance(t);
  return value;
}
