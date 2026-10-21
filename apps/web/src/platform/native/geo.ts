import type { BackgroundGeolocationPlugin, Location, WatcherOptions } from '@capacitor-community/background-geolocation';
import type { GeoError, GeoProvider, RawFix } from '../../core/services';
import { accuracyOrUnknown, finiteOrNull, headingOrNull, speedOrNull } from '../common/fix';

export const BACKGROUND_TITLE = 'Intercom Nav';
export const BACKGROUND_MESSAGE = 'Sharing your location with your riding group.';

export interface NativeGeoDeps {
  plugin: BackgroundGeolocationPlugin;
  kind: 'android' | 'ios';
  /**
   * Android: resolves true once location permission is granted (through the serialised permission
   * broker). Omitted on iOS, where the plugin prompts by itself.
   */
  ensurePermission?: () => Promise<boolean>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export function locationToRawFix(loc: Location): RawFix {
  return {
    lat: loc.latitude,
    lng: loc.longitude,
    accuracy: accuracyOrUnknown(loc.accuracy),
    speed: speedOrNull(loc.speed),
    heading: headingOrNull(loc.bearing),
    altitude: finiteOrNull(loc.altitude),
    timestamp: finiteOrNull(loc.time) ?? Date.now(),
  };
}

export function mapPluginError(err: { code?: string; message?: string }): GeoError {
  const message = err.message || 'Location error';
  if (err.code === 'NOT_AUTHORIZED') {
    // The plugin also uses NOT_AUTHORIZED for "location services switched off".
    return /disabled/i.test(message)
      ? { code: 'unavailable', message: 'Location services are turned off' }
      : { code: 'denied', message: 'Location permission was denied' };
  }
  return { code: 'unknown', message };
}

/**
 * The plugin's Android service binds asynchronously when the plugin loads, and addWatcher before
 * that fails with "Service not running." That failure arrives through the watcher callback (the
 * call isn't kept alive afterwards), so the watcher is re-added from there.
 */
const SERVICE_NOT_READY = /service not running/i;
const ATTACH_ATTEMPTS = 10;
const ATTACH_RETRY_MS = 300;

/**
 * Positions from @capacitor-community/background-geolocation (FusedLocationProvider at 1 Hz on
 * Android, CLLocationManager on iOS).
 *
 * Android: no `backgroundMessage`, so the plugin doesn't start a second foreground service and
 * notification of its own. Background delivery comes from our RideService, a foreground service of
 * type `location` started while the app is visible, which keeps "while in use" location access for
 * the whole app while the screen is off. Permissions are requested by us first (requestPermissions
 * false) because the plugin's own request path starts its service before the user has answered.
 *
 * iOS: `backgroundMessage` must be set; it is what turns on allowsBackgroundLocationUpdates.
 */
export function createNativeGeo(deps: NativeGeoDeps): GeoProvider {
  const { plugin, kind } = deps;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let watcherId: string | null = null;
  let retryTimer: unknown = null;
  /** Bumped on every start/stop; callbacks and retries from an older session are ignored. */
  let session = 0;

  const options: WatcherOptions =
    kind === 'ios'
      ? {
          backgroundMessage: BACKGROUND_MESSAGE,
          backgroundTitle: BACKGROUND_TITLE,
          requestPermissions: true,
          stale: false,
          distanceFilter: 0,
        }
      : { requestPermissions: false, stale: false, distanceFilter: 0 };

  async function removeWatcher(id: string): Promise<void> {
    try {
      await plugin.removeWatcher({ id });
    } catch (err) {
      console.warn('[platform] removeWatcher failed', err);
    }
  }

  async function detach(): Promise<void> {
    if (retryTimer !== null) clearTimer(retryTimer);
    retryTimer = null;
    const id = watcherId;
    watcherId = null;
    if (id) await removeWatcher(id);
  }

  async function attach(
    current: number,
    attempt: number,
    onFix: (fix: RawFix) => void,
    onError: (err: GeoError) => void,
  ): Promise<void> {
    let id: string;
    try {
      // Typed as Promise<string>; Capacitor actually returns the callback id synchronously.
      id = await plugin.addWatcher(options, (loc, err) => {
        if (current !== session) return;
        if (err) {
          if (SERVICE_NOT_READY.test(err.message ?? '') && attempt < ATTACH_ATTEMPTS) {
            watcherId = null; // that call is dead; it isn't kept alive after a rejection
            retryTimer = setTimer(() => {
              retryTimer = null;
              if (current === session) void attach(current, attempt + 1, onFix, onError);
            }, ATTACH_RETRY_MS);
            return;
          }
          onError(mapPluginError(err));
        } else if (loc) {
          onFix(locationToRawFix(loc));
        }
      });
    } catch (err) {
      if (current === session) {
        onError({ code: 'unknown', message: err instanceof Error ? err.message : 'Could not start location updates' });
      }
      return;
    }
    if (current !== session) await removeWatcher(id); // stop() or a newer start() won the race
    else watcherId = id;
  }

  return {
    async start(onFix, onError) {
      const current = ++session;
      await detach();
      if (current !== session) return;

      if (deps.ensurePermission) {
        const granted = await deps.ensurePermission().catch((err: unknown) => {
          console.warn('[platform] location permission request failed', err);
          return false;
        });
        if (current !== session) return;
        if (!granted) {
          onError({ code: 'denied', message: 'Location permission was denied' });
          return;
        }
      }
      await attach(current, 1, onFix, onError);
    },

    async stop() {
      session++;
      await detach();
    },
  };
}
