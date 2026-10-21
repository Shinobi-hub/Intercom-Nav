import { haversineM } from '@intercom/shared';
import type { RawFix } from '../../core/services';

export interface FixFilterOptions {
  /** Fixes less accurate than this are dropped while better ones keep arriving. */
  maxAccuracyM: number;
  /** When no fix within maxAccuracyM was accepted for this long, coarser fixes are let through... */
  relaxAfterMs: number;
  /** ...up to this accuracy. */
  relaxedMaxAccuracyM: number;
  /** Movement implying a higher speed than this is treated as a glitch... */
  maxSpeedMps: number;
  /** ...unless this many consecutive fixes agree with each other (tunnel exit, bad first fix). */
  jumpConfirmFixes: number;
}

export const DEFAULT_FILTER_OPTIONS: FixFilterOptions = {
  maxAccuracyM: 50,
  relaxAfterMs: 20_000,
  relaxedMaxAccuracyM: 150,
  maxSpeedMps: 120,
  jumpConfirmFixes: 3,
};

export type RejectReason = 'invalid' | 'out_of_order' | 'inaccurate' | 'jump';

export type FilterVerdict =
  /** `discontinuity`: a confirmed jump; smoothing must restart from this fix. */
  | { accepted: true; discontinuity: boolean }
  | { accepted: false; reason: RejectReason };

function isValid(f: RawFix): boolean {
  return (
    Number.isFinite(f.lat) &&
    Number.isFinite(f.lng) &&
    Math.abs(f.lat) <= 90 &&
    Math.abs(f.lng) <= 180 &&
    Number.isFinite(f.accuracy) &&
    f.accuracy >= 0 &&
    Number.isFinite(f.timestamp) &&
    f.timestamp > 0
  );
}

/**
 * Speed implied by moving from `a` to `b`, counting only the distance beyond both fixes' stated
 * accuracy. Without that allowance, two good fixes 100 ms apart would look supersonic.
 */
export function impliedSpeedMps(a: RawFix, b: RawFix): number {
  const dt = (b.timestamp - a.timestamp) / 1000;
  const excess = Math.max(0, haversineM(a, b) - a.accuracy - b.accuracy);
  if (excess === 0) return 0;
  return dt > 0 ? excess / dt : Infinity;
}

/**
 * First stage of the location pipeline: decides which raw provider fixes are trustworthy.
 * Time is taken from fix timestamps only, so the filter is deterministic and replayable.
 */
export class FixFilter {
  private readonly opts: FixFilterOptions;
  private lastAccepted: RawFix | null = null;
  /** Timestamp of the last accepted fix that met maxAccuracyM (or of the first fix ever seen). */
  private lastGoodAt: number | null = null;
  /** Consecutive fixes that agree with each other but not with lastAccepted. */
  private jumpRun: RawFix[] = [];

  constructor(options: Partial<FixFilterOptions> = {}) {
    this.opts = { ...DEFAULT_FILTER_OPTIONS, ...options };
  }

  reset(): void {
    this.lastAccepted = null;
    this.lastGoodAt = null;
    this.jumpRun = [];
  }

  check(fix: RawFix): FilterVerdict {
    if (!isValid(fix)) return { accepted: false, reason: 'invalid' };
    const o = this.opts;
    this.lastGoodAt ??= fix.timestamp;

    const newest = this.jumpRun.at(-1) ?? this.lastAccepted;
    if (newest && fix.timestamp <= newest.timestamp) return { accepted: false, reason: 'out_of_order' };

    // Relaxation lasts until a good fix arrives again, so riders with persistently mediocre GPS
    // still move on the map instead of updating once every relaxAfterMs.
    const relaxed = fix.timestamp - this.lastGoodAt >= o.relaxAfterMs;
    const limit = relaxed ? o.relaxedMaxAccuracyM : o.maxAccuracyM;
    if (fix.accuracy > limit) return { accepted: false, reason: 'inaccurate' };

    const last = this.lastAccepted;
    if (last && impliedSpeedMps(last, fix) > o.maxSpeedMps) {
      const prev = this.jumpRun.at(-1);
      if (prev && impliedSpeedMps(prev, fix) <= o.maxSpeedMps) this.jumpRun.push(fix);
      else this.jumpRun = [fix];
      if (this.jumpRun.length < o.jumpConfirmFixes) return { accepted: false, reason: 'jump' };
      this.accept(fix);
      return { accepted: true, discontinuity: true };
    }

    this.accept(fix);
    return { accepted: true, discontinuity: false };
  }

  private accept(fix: RawFix): void {
    this.lastAccepted = fix;
    this.jumpRun = [];
    if (fix.accuracy <= this.opts.maxAccuracyM) this.lastGoodAt = fix.timestamp;
  }
}
