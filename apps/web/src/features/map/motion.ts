import {
  bearingDeg,
  clamp,
  destinationPoint,
  haversineM,
  lerpAngleDeg,
  normalizeLng,
  TIMING,
  type LatLng,
} from '@intercom/shared';

export type TrackState = 'live' | 'stale' | 'lost';

export interface MotionOptions {
  /** Glide duration bounds; the glide lasts as long as the observed update interval. */
  minGlideMs: number;
  maxGlideMs: number;
  /** Glide duration before an update interval has been observed. */
  defaultGlideMs: number;
  /** Weight of the newest interval in the update-interval EMA. */
  intervalSmoothing: number;
  /** Fixes further than this from the drawn position are jumped to, not glided to. */
  teleportM: number;
  deadReckonMaxMs: number;
  /** No dead reckoning below this speed. */
  deadReckonMinSpeedMps: number;
  /** A fix without a heading gets the bearing from the previous fix if they are this far apart. */
  minBearingM: number;
  staleMs: number;
  lostMs: number;
}

export const DEFAULT_MOTION_OPTIONS: MotionOptions = {
  minGlideMs: 250,
  maxGlideMs: 2_000,
  defaultGlideMs: 1_000,
  intervalSmoothing: 0.3,
  teleportM: 2_000,
  deadReckonMaxMs: TIMING.deadReckonMaxMs,
  deadReckonMinSpeedMps: 1,
  minBearingM: 3,
  staleMs: TIMING.riderStaleMs,
  lostMs: TIMING.riderLostMs,
};

export interface MotionFix extends LatLng {
  hdg: number | null;
  spd: number | null;
  /** Fix time, ms since epoch. Repeats and older fixes are ignored. */
  t: number;
}

export interface MotionSample extends LatLng {
  hdg: number | null;
  state: TrackState;
  /** True while drawn ahead of the newest fix by dead reckoning. */
  extrapolating: boolean;
  /** Time since the newest fix was received. */
  ageMs: number;
}

const usable = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/** Fixes without a speed get one derived from the previous fix, if they are at least this far apart in time... */
const MIN_SPEED_BASELINE_MS = 250;
/** ...capped so a glitch can't fling the marker across the map while dead reckoning. */
const MAX_DERIVED_SPEED_MPS = 85;

function lerpHeading(a: number | null, b: number | null, k: number): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return lerpAngleDeg(a, b, k);
}

/**
 * Where to draw one rider between fixes. Each new fix starts a constant-velocity glide from the
 * currently drawn position to the fix, lasting about one update interval, so the marker arrives as
 * the next fix is due. If that fix is late, the marker dead-reckons along its heading at the last
 * speed for a while, then holds. All times are local monotonic ms (performance.now()).
 */
export class MotionTrack {
  private readonly o: MotionOptions;
  private target: MotionFix | null = null;
  private targetAged = false;
  private receivedAt = 0;
  private from: LatLng = { lat: 0, lng: 0 };
  private fromHdg: number | null = null;
  private toHdg: number | null = null;
  private glideStart = 0;
  private glideMs = 0;
  private intervalEma: number | null = null;
  private drSpeed = 0;

  constructor(options: Partial<MotionOptions> = {}) {
    this.o = { ...DEFAULT_MOTION_OPTIONS, ...options };
  }

  get fix(): MotionFix | null {
    return this.target;
  }

  /** Local time the newest fix was received (back-dated for fixes that arrived already old). */
  get lastReceivedAt(): number | null {
    return this.target ? this.receivedAt : null;
  }

  /**
   * Feeds a fix received at `now`. `agedMs` > 0 marks a fix that was already that old on arrival
   * (e.g. from a join snapshot): it is shown where it is, without gliding or dead reckoning, and its
   * staleness counts from when it was really received. Returns false for repeats and older fixes.
   */
  push(fix: MotionFix, now: number, agedMs = 0): boolean {
    const o = this.o;
    const prev = this.target;
    if (prev && fix.t <= prev.t) return false;
    const aged = agedMs > 0;
    const drawn = this.sample(now);

    if (prev && !aged && !this.targetAged) {
      const interval = clamp(now - this.receivedAt, o.minGlideMs, o.maxGlideMs);
      this.intervalEma =
        this.intervalEma === null ? interval : this.intervalEma + o.intervalSmoothing * (interval - this.intervalEma);
    }

    let heading: number | null = usable(fix.hdg) ? fix.hdg : null;
    if (heading === null && prev && haversineM(prev, fix) >= o.minBearingM) heading = bearingDeg(prev, fix);
    heading ??= drawn?.hdg ?? null;

    let speed = usable(fix.spd) ? fix.spd : 0;
    if (!usable(fix.spd) && prev && fix.t - prev.t >= MIN_SPEED_BASELINE_MS) {
      speed = Math.min(MAX_DERIVED_SPEED_MPS, haversineM(prev, fix) / ((fix.t - prev.t) / 1000));
    }

    const snap = !drawn || aged || haversineM(drawn, fix) > o.teleportM;
    this.from = snap ? { lat: fix.lat, lng: fix.lng } : { lat: drawn.lat, lng: drawn.lng };
    this.fromHdg = snap ? heading : drawn.hdg;
    this.toHdg = heading;
    this.glideStart = now;
    this.glideMs = snap ? 0 : clamp(this.intervalEma ?? o.defaultGlideMs, o.minGlideMs, o.maxGlideMs);
    this.target = fix;
    this.targetAged = aged;
    this.receivedAt = now - Math.max(0, agedMs);
    this.drSpeed = aged ? 0 : speed;
    return true;
  }

  sample(now: number): MotionSample | null {
    const fix = this.target;
    if (!fix) return null;
    const o = this.o;
    const ageMs = Math.max(0, now - this.receivedAt);
    const state: TrackState = ageMs >= o.lostMs ? 'lost' : ageMs >= o.staleMs ? 'stale' : 'live';
    const elapsed = Math.max(0, now - this.glideStart);

    if (elapsed < this.glideMs) {
      const k = elapsed / this.glideMs;
      const lng = normalizeLng(this.from.lng + normalizeLng(fix.lng - this.from.lng) * k);
      return {
        lat: this.from.lat + (fix.lat - this.from.lat) * k,
        lng,
        hdg: lerpHeading(this.fromHdg, this.toHdg, k),
        state,
        extrapolating: false,
        ageMs,
      };
    }

    const sinceArrival = elapsed - this.glideMs;
    if (this.drSpeed > o.deadReckonMinSpeedMps && this.toHdg !== null && sinceArrival > 0) {
      const ms = Math.min(sinceArrival, o.deadReckonMaxMs);
      const p = destinationPoint(fix, this.toHdg, (this.drSpeed * ms) / 1000);
      return { ...p, hdg: this.toHdg, state, extrapolating: sinceArrival < o.deadReckonMaxMs, ageMs };
    }
    return { lat: fix.lat, lng: fix.lng, hdg: this.toHdg, state, extrapolating: false, ageMs };
  }
}
