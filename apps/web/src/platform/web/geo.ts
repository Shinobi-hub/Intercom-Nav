import type { GeoError, GeoProvider, RawFix } from '../../core/services';
import { accuracyOrUnknown, finiteOrNull, headingOrNull, speedOrNull } from '../common/fix';

/** maximumAge 0: never a cached fix. The timeout only bounds each attempt; see `retryDelayMs`. */
export const WEB_GEO_OPTIONS: PositionOptions = { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 };

/** GeolocationPositionError codes from the spec. */
const PERMISSION_DENIED = 1;
const POSITION_UNAVAILABLE = 2;
const TIMEOUT = 3;

export function mapGeoError(err: { code?: number; message?: string } | null | undefined): GeoError {
  const message = err?.message?.trim();
  switch (err?.code) {
    case PERMISSION_DENIED:
      return { code: 'denied', message: message || 'Location permission was denied' };
    case POSITION_UNAVAILABLE:
      return { code: 'unavailable', message: message || 'No position available' };
    case TIMEOUT:
      return { code: 'timeout', message: message || 'Timed out waiting for a position' };
    default:
      return { code: 'unknown', message: message || 'Unknown geolocation error' };
  }
}

export function positionToRawFix(pos: GeolocationPosition): RawFix {
  const c = pos.coords;
  return {
    lat: c.latitude,
    lng: c.longitude,
    accuracy: accuracyOrUnknown(c.accuracy),
    speed: speedOrNull(c.speed),
    // Browsers report NaN heading while stationary.
    heading: headingOrNull(c.heading),
    altitude: finiteOrNull(c.altitude),
    timestamp: Number.isFinite(pos.timestamp) ? pos.timestamp : Date.now(),
  };
}

/**
 * After a non-fatal error the watch is re-armed (clearWatch + watchPosition). Chrome keeps a watch
 * running after a timeout, but not every engine does, and re-arming is harmless where it does.
 */
function retryDelayMs(code: GeoError['code']): number | null {
  switch (code) {
    case 'denied':
      return null; // fatal: stop until the controller calls start() again
    case 'timeout':
      return 0; // the attempt already waited WEB_GEO_OPTIONS.timeout
    default:
      return 5_000; // unavailable/unknown: don't spin if it fails immediately
  }
}

/** navigator.geolocation.watchPosition with high accuracy. Timeouts are reported but not fatal. */
export function createWebGeo(getGeolocation: () => Geolocation | undefined = () => navigator.geolocation): GeoProvider {
  let watchId: number | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped on every start/stop, so callbacks from an older watch are ignored. */
  let session = 0;

  function clear(geo: Geolocation | undefined): void {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    if (watchId !== null) geo?.clearWatch(watchId);
    watchId = null;
  }

  return {
    async start(onFix, onError) {
      const geo = getGeolocation();
      clear(geo);
      const current = ++session;
      if (!geo) {
        onError({ code: 'unavailable', message: 'Geolocation is not supported on this device' });
        return;
      }

      const watch = (): void => {
        retryTimer = null;
        if (current !== session) return;
        watchId = geo.watchPosition(
          (pos) => {
            if (current === session) onFix(positionToRawFix(pos));
          },
          (err) => {
            if (current !== session) return;
            const error = mapGeoError(err);
            onError(error);
            const delay = retryDelayMs(error.code);
            clear(geo);
            if (delay !== null) retryTimer = setTimeout(watch, delay);
          },
          WEB_GEO_OPTIONS,
        );
      };
      watch();
    },

    async stop() {
      session++;
      clear(getGeolocation());
    },
  };
}
