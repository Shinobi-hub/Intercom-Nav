import { clamp, haversineM, TIMING, type LocationFix } from '@intercom/shared';
import { registerDebug } from '../../core/debug';
import type { GeoError, GeoProvider, LocationServiceApi, RawFix, Unsubscribe } from '../../core/services';
import { useLocalStore, type GpsInfo } from '../../core/store';
import { FixFilter } from './filter';
import { HeadingSpeedEstimator, type HeadingSpeed } from './headingSpeed';
import { PositionKalman, type KalmanEstimate } from './kalman';
import { shouldSend, type SentRecord } from './sendPolicy';

export interface LocationServiceDeps {
  geo: GeoProvider;
}

/** Heartbeats repeat the newest fix only while it is younger than this (local receive time). */
export const HEARTBEAT_MAX_FIX_AGE_MS = TIMING.locHeartbeatMaxFixAgeMs;

/** Accuracy assumed for debug-injected fixes that don't state one. */
const DEBUG_DEFAULT_ACCURACY_M = 5;

type Listener = (fix: LocationFix) => void;

const usable = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

function round(v: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

/** Speed between two consecutive accepted raw fixes; scales the smoother when the provider has none. */
function rawSpeed(prev: RawFix | null, cur: RawFix): number | null {
  if (!prev) return null;
  const dt = (cur.timestamp - prev.timestamp) / 1000;
  return dt > 0 ? haversineM(prev, cur) / dt : null;
}

function toLocationFix(est: KalmanEstimate, raw: RawFix, motion: HeadingSpeed): LocationFix {
  return {
    lat: round(est.lat, 7),
    lng: round(est.lng, 7),
    // The raw accuracy, not the filter's sigma: GPS errors are correlated over time, so the
    // posterior would claim a precision the fix doesn't have.
    acc: round(raw.accuracy, 1),
    spd: motion.spd === null ? null : round(clamp(motion.spd, 0, 150), 2),
    hdg: motion.hdg === null ? null : round(motion.hdg, 1) % 360,
    alt: usable(raw.altitude) ? round(clamp(raw.altitude, -1_000, 20_000), 1) : null,
    t: Math.round(raw.timestamp),
  };
}

function asGeoError(e: unknown): GeoError {
  if (e && typeof e === 'object' && 'code' in e && typeof (e as GeoError).code === 'string') {
    const { code, message } = e as GeoError;
    if (code === 'denied' || code === 'unavailable' || code === 'timeout') return { code, message: String(message ?? '') };
  }
  return { code: 'unknown', message: e instanceof Error ? e.message : String(e) };
}

function emit(listeners: Set<Listener>, fix: LocationFix): void {
  for (const cb of [...listeners]) {
    try {
      cb(fix);
    } catch (e) {
      console.error('[geo] listener failed', e);
    }
  }
}

/**
 * The location pipeline: provider -> filter -> Kalman smoothing -> heading/speed -> send policy.
 * Publishes useLocalStore.gps and .selfFix; `onSend` fixes are what the controller sends to the server.
 */
export function createLocationService({ geo }: LocationServiceDeps): LocationServiceApi {
  const fixListeners = new Set<Listener>();
  const sendListeners = new Set<Listener>();
  const filter = new FixFilter();
  const kalman = new PositionKalman();
  const motion = new HeadingSpeedEstimator();
  const store = useLocalStore.getState;

  let lastRaw: RawFix | null = null;
  let newest: { fix: LocationFix; receivedAt: number } | null = null;
  let lastSent: SentRecord | null = null;
  let heartbeat: ReturnType<typeof setTimeout> | null = null;

  let running = false;
  /** Bumped by every start/stop so callbacks from a superseded provider session are ignored. */
  let session = 0;
  let providerActive = false;
  let pendingStart: Promise<void> | null = null;
  /** Provider start/stop calls run strictly one after another. */
  let queue: Promise<void> = Promise.resolve();

  function enqueue(op: () => Promise<void>): Promise<void> {
    const next = queue.then(op);
    queue = next.catch(() => {});
    return next;
  }

  function setGps(p: Partial<GpsInfo>): void {
    store().setGps(p);
  }

  function resetPipeline(): void {
    filter.reset();
    kalman.reset();
    motion.reset();
    lastRaw = null;
    newest = null;
  }

  function process(raw: RawFix): void {
    const verdict = filter.check(raw);
    if (!verdict.accepted) return;
    if (verdict.discontinuity) {
      kalman.reset();
      motion.reset();
      lastRaw = null;
    }
    const providerSpeed = usable(raw.speed) && raw.speed >= 0 ? raw.speed : null;
    const est = kalman.update({
      lat: raw.lat,
      lng: raw.lng,
      accuracyM: raw.accuracy,
      t: raw.timestamp,
      speedMps: providerSpeed ?? rawSpeed(lastRaw, raw),
    });
    lastRaw = raw;
    const hs = motion.update({ lat: est.lat, lng: est.lng, t: raw.timestamp }, { speed: providerSpeed, heading: raw.heading });
    const fix = toLocationFix(est, raw, hs);

    const now = Date.now();
    newest = { fix, receivedAt: now };
    store().setSelfFix(fix);
    setGps({ status: 'active', accuracyM: fix.acc, lastFixAt: now, error: null });
    emit(fixListeners, fix);
    if (shouldSend(fix, lastSent, now)) send(fix, now);
  }

  function send(fix: LocationFix, now: number): void {
    // The server and the stores drop fixes that aren't newer than the last one, so keep `t` strictly
    // increasing even when a heartbeat (stamped with the local clock) overtook a provider timestamp.
    const minT = lastSent ? lastSent.fix.t + 1 : 1;
    const out = fix.t >= minT ? fix : { ...fix, t: minT };
    lastSent = { fix: out, at: now };
    emit(sendListeners, out);
    armHeartbeat(TIMING.locHeartbeatMs);
  }

  function armHeartbeat(delayMs: number): void {
    if (heartbeat) clearTimeout(heartbeat);
    heartbeat = running ? setTimeout(beat, delayMs) : null;
  }

  /** Re-sends the newest fix when the OS goes quiet (stationary riders), so others don't see us go stale. */
  function beat(): void {
    heartbeat = null;
    if (!running || !newest) return;
    const now = Date.now();
    const quietMs = lastSent ? now - lastSent.at : Infinity;
    if (quietMs < TIMING.locHeartbeatMs) {
      armHeartbeat(TIMING.locHeartbeatMs - quietMs);
      return;
    }
    // A fix this old no longer says where we are; stop vouching for it and let riders see us go stale.
    if (now - newest.receivedAt >= HEARTBEAT_MAX_FIX_AGE_MS) return;
    send({ ...newest.fix, t: now }, now);
  }

  function reportError(err: GeoError): void {
    const message = err.message || null;
    switch (err.code) {
      case 'denied':
        setGps({ status: 'denied', error: message ?? 'Location permission denied' });
        break;
      case 'unavailable':
        setGps({ status: 'unavailable', error: message ?? 'Position unavailable' });
        break;
      case 'timeout': {
        // Providers time out routinely when a stationary device stops producing fixes; that only
        // means "no signal" once we haven't had a fix for a while.
        const recent = newest !== null && Date.now() - newest.receivedAt < HEARTBEAT_MAX_FIX_AGE_MS;
        setGps(recent ? { error: message } : { status: 'unavailable', error: message ?? 'No GPS signal' });
        break;
      }
      default:
        setGps({ status: 'error', error: message ?? 'Location error' });
    }
  }

  const api: LocationServiceApi = {
    start() {
      const status = store().gps.status;
      if (running && (status === 'active' || status === 'starting')) return pendingStart ?? Promise.resolve();
      // Not running, or running but the provider reported a failure: (re)start it.
      running = true;
      const id = ++session;
      resetPipeline();
      setGps({ status: 'starting', error: null });
      const p = enqueue(async () => {
        if (id !== session) return;
        if (providerActive) {
          providerActive = false;
          await geo.stop().catch((e: unknown) => console.warn('[geo] provider stop failed', e));
        }
        try {
          providerActive = true;
          await geo.start(
            (raw) => {
              if (id === session) process(raw);
            },
            (err) => {
              if (id === session) reportError(err);
            },
          );
        } catch (e) {
          providerActive = false;
          if (id === session) reportError(asGeoError(e));
        }
      });
      pendingStart = p.finally(() => {
        if (pendingStart === p) pendingStart = null;
      });
      return pendingStart;
    },

    stop() {
      if (!running && !providerActive) return queue;
      running = false;
      ++session;
      if (heartbeat) clearTimeout(heartbeat);
      heartbeat = null;
      setGps({ status: 'off' });
      return enqueue(async () => {
        if (!providerActive) return;
        providerActive = false;
        await geo.stop().catch((e: unknown) => console.warn('[geo] provider stop failed', e));
      });
    },

    onFix(cb): Unsubscribe {
      fixListeners.add(cb);
      return () => fixListeners.delete(cb);
    },

    onSend(cb): Unsubscribe {
      sendListeners.add(cb);
      return () => sendListeners.delete(cb);
    },

    inject(raw) {
      process(raw);
    },
  };

  let lastDebugTs = 0;
  registerDebug('geo', {
    inject(f) {
      // Two injections in the same millisecond would otherwise be dropped as out of order.
      const timestamp = f.timestamp ?? Math.max(Date.now(), lastDebugTs + 1);
      lastDebugTs = Math.max(lastDebugTs, timestamp);
      api.inject({
        lat: f.lat,
        lng: f.lng,
        accuracy: f.accuracy ?? DEBUG_DEFAULT_ACCURACY_M,
        speed: f.speed ?? null,
        heading: f.heading ?? null,
        altitude: null,
        timestamp,
      });
    },
    lastSent: () => lastSent?.fix ?? null,
  });

  return api;
}
