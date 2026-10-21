import { normalizeLng } from '@intercom/shared';

export interface KalmanOptions {
  /**
   * Process noise floor, m/s. Bounds how far an apparently stationary rider may drift per second;
   * lower values smooth jitter harder but react more slowly when the rider starts moving.
   */
  minProcessSpeedMps: number;
}

export const DEFAULT_KALMAN_OPTIONS: KalmanOptions = { minProcessSpeedMps: 1 };

export interface KalmanMeasurement {
  lat: number;
  lng: number;
  /** 1-sigma horizontal accuracy, meters. */
  accuracyM: number;
  /** ms */
  t: number;
  /** Best available current speed (provider or derived), m/s; null when unknown. */
  speedMps: number | null;
}

export interface KalmanEstimate {
  lat: number;
  lng: number;
  /** 1-sigma uncertainty of the estimate, meters. */
  sigmaM: number;
  t: number;
}

/** Floor for the measurement noise; providers sometimes report 0 m, which would freeze the filter. */
const MIN_ACCURACY_M = 1;

/**
 * Isotropic constant-position Kalman filter on lat/lng. Each fix's accuracy is the measurement
 * noise; the process noise is the distance the rider could have covered since the last fix at the
 * current speed. That makes the filter smooth hard when standing still (jitter averages out) and
 * almost pass-through at highway speed (gain close to 1), so it never trails a fast rider.
 */
export class PositionKalman {
  private readonly opts: KalmanOptions;
  private state: { lat: number; lng: number; varM2: number; t: number } | null = null;

  constructor(options: Partial<KalmanOptions> = {}) {
    this.opts = { ...DEFAULT_KALMAN_OPTIONS, ...options };
  }

  get estimate(): KalmanEstimate | null {
    const s = this.state;
    return s ? { lat: s.lat, lng: s.lng, sigmaM: Math.sqrt(s.varM2), t: s.t } : null;
  }

  reset(): void {
    this.state = null;
  }

  update(m: KalmanMeasurement): KalmanEstimate {
    const accuracy = Math.max(MIN_ACCURACY_M, m.accuracyM);
    const r = accuracy * accuracy;
    const s = this.state;
    if (!s) {
      this.state = { lat: m.lat, lng: m.lng, varM2: r, t: m.t };
      return this.estimate!;
    }

    const dt = Math.max(0, (m.t - s.t) / 1000);
    const speed = Math.max(this.opts.minProcessSpeedMps, m.speedMps ?? 0);
    const reach = speed * dt;
    const prior = s.varM2 + reach * reach;
    const gain = prior / (prior + r);

    s.lat += gain * (m.lat - s.lat);
    s.lng = normalizeLng(s.lng + gain * normalizeLng(m.lng - s.lng));
    s.varM2 = (1 - gain) * prior;
    s.t = Math.max(s.t, m.t);
    return this.estimate!;
  }
}
