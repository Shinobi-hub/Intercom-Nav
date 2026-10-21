import { bearingDeg, haversineM, normalizeDeg, type LatLng } from '@intercom/shared';

export interface HeadingSpeedOptions {
  /** The provider's heading is trusted above this speed (it is noise when crawling). */
  providerHeadingMinSpeedMps: number;
  /** Otherwise the bearing between smoothed fixes is used once they are this far apart. */
  minBearingDistanceM: number;
  /** Derived speed is measured over about this long a baseline (shorter reacts faster, longer is calmer)... */
  speedBaselineMs: number;
  /** ...never shorter than this, so bursts of fixes don't produce wild speeds... */
  minSpeedBaselineMs: number;
  /** ...and never across a gap longer than this. */
  maxSpeedBaselineMs: number;
}

export const DEFAULT_HEADING_SPEED_OPTIONS: HeadingSpeedOptions = {
  providerHeadingMinSpeedMps: 1.5,
  minBearingDistanceM: 8,
  speedBaselineMs: 2_000,
  minSpeedBaselineMs: 500,
  maxSpeedBaselineMs: 10_000,
};

export interface TimedPoint extends LatLng {
  /** ms */
  t: number;
}

export interface ProviderMotion {
  speed: number | null;
  heading: number | null;
}

export interface HeadingSpeed {
  /** m/s, null when unknown. */
  spd: number | null;
  /** Degrees in [0, 360), null until a heading has been established. */
  hdg: number | null;
}

const usable = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Fills in speed and heading for smoothed fixes:
 * - speed: the provider's, else derived from recent smoothed fixes;
 * - heading: the provider's while moving faster than 1.5 m/s, else the bearing from the point where
 *   the heading was last set once the rider has moved more than 8 m from it, else the last heading
 *   (a stopped rider keeps pointing where they were going).
 */
export class HeadingSpeedEstimator {
  private readonly opts: HeadingSpeedOptions;
  private history: TimedPoint[] = [];
  private anchor: TimedPoint | null = null;
  private heading: number | null = null;

  constructor(options: Partial<HeadingSpeedOptions> = {}) {
    this.opts = { ...DEFAULT_HEADING_SPEED_OPTIONS, ...options };
  }

  reset(): void {
    this.history = [];
    this.anchor = null;
    this.heading = null;
  }

  update(p: TimedPoint, provider: ProviderMotion): HeadingSpeed {
    const o = this.opts;
    const derived = this.deriveSpeed(p);
    const spd = usable(provider.speed) && provider.speed >= 0 ? provider.speed : derived;

    if (usable(provider.heading) && spd !== null && spd > o.providerHeadingMinSpeedMps) {
      this.heading = normalizeDeg(provider.heading);
      this.anchor = p;
    } else if (!this.anchor) {
      this.anchor = p;
    } else if (haversineM(this.anchor, p) > o.minBearingDistanceM) {
      this.heading = bearingDeg(this.anchor, p);
      this.anchor = p;
    }
    return { spd, hdg: this.heading };
  }

  private deriveSpeed(p: TimedPoint): number | null {
    const o = this.opts;
    this.history = this.history.filter((h) => h.t < p.t && p.t - h.t <= o.maxSpeedBaselineMs);
    // Newest point at least speedBaselineMs old, else the oldest one we have.
    let ref: TimedPoint | undefined;
    for (const h of this.history) {
      if (p.t - h.t >= o.speedBaselineMs) ref = h;
    }
    ref ??= this.history[0];
    this.history.push(p);
    if (!ref || p.t - ref.t < o.minSpeedBaselineMs) return null;
    return haversineM(ref, p) / ((p.t - ref.t) / 1000);
  }
}
