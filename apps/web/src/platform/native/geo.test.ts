import type {
  BackgroundGeolocationPlugin,
  CallbackError,
  Location,
  WatcherOptions,
} from '@capacitor-community/background-geolocation';
import { describe, expect, it, vi } from 'vitest';
import { BACKGROUND_MESSAGE, createNativeGeo, locationToRawFix, mapPluginError } from './geo';

type Callback = (position?: Location, error?: CallbackError) => void;

function fakePlugin() {
  const watchers = new Map<string, { options: WatcherOptions; callback: Callback }>();
  let next = 1;
  const addWatcher = vi.fn(async (options: WatcherOptions, callback: Callback) => {
    const id = String(next++);
    watchers.set(id, { options, callback });
    return id;
  });
  const removeWatcher = vi.fn(async ({ id }: { id: string }) => {
    watchers.delete(id);
  });
  const latest = () => [...watchers.values()].at(-1)!;
  return {
    plugin: { addWatcher, removeWatcher, openSettings: vi.fn() } as unknown as BackgroundGeolocationPlugin,
    addWatcher,
    removeWatcher,
    watchers,
    emit: (loc: Partial<Location>) =>
      latest().callback({
        latitude: 1,
        longitude: 2,
        accuracy: 5,
        altitude: null,
        altitudeAccuracy: null,
        simulated: false,
        bearing: null,
        speed: null,
        time: 1000,
        ...loc,
      }),
    fail: (message: string, code?: string) => latest().callback(undefined, Object.assign(new Error(message), { code })),
  };
}

/** Synchronous timers so retries can be stepped. */
function manualTimers() {
  const queue: Array<() => void> = [];
  return {
    setTimer: (fn: () => void) => queue.push(fn),
    clearTimer: vi.fn(),
    runAll: () => queue.splice(0).forEach((fn) => fn()),
  };
}

describe('locationToRawFix', () => {
  it('maps plugin locations to raw fixes', () => {
    const fix = locationToRawFix({
      latitude: 48.1,
      longitude: 11.5,
      accuracy: 6,
      altitude: 520,
      altitudeAccuracy: 3,
      simulated: false,
      bearing: 361,
      speed: 22.2,
      time: 1_700_000_000_000,
    });
    expect(fix).toEqual({
      lat: 48.1,
      lng: 11.5,
      accuracy: 6,
      speed: 22.2,
      heading: 1,
      altitude: 520,
      timestamp: 1_700_000_000_000,
    });
  });

  it('treats iOS "-1 = invalid" speed/bearing as missing', () => {
    const fix = locationToRawFix({
      latitude: 0,
      longitude: 0,
      accuracy: 5,
      altitude: null,
      altitudeAccuracy: null,
      simulated: false,
      bearing: -1,
      speed: -1,
      time: null,
    });
    expect(fix.speed).toBeNull();
    expect(fix.heading).toBeNull();
    expect(fix.timestamp).toBeGreaterThan(0);
  });
});

describe('mapPluginError', () => {
  it('separates denied permission from switched-off location services', () => {
    expect(mapPluginError({ code: 'NOT_AUTHORIZED', message: 'Permission denied.' }).code).toBe('denied');
    expect(mapPluginError({ code: 'NOT_AUTHORIZED', message: 'Location services disabled.' }).code).toBe('unavailable');
    expect(mapPluginError({ message: 'boom' })).toEqual({ code: 'unknown', message: 'boom' });
  });
});

describe('createNativeGeo (android)', () => {
  it('requests permission itself, then watches without a second foreground notification', async () => {
    const f = fakePlugin();
    const ensurePermission = vi.fn(async () => true);
    const onFix = vi.fn();
    await createNativeGeo({ plugin: f.plugin, kind: 'android', ensurePermission }).start(onFix, vi.fn());

    expect(ensurePermission).toHaveBeenCalled();
    const options = f.addWatcher.mock.calls[0]![0];
    expect(options).toEqual({ requestPermissions: false, stale: false, distanceFilter: 0 });
    expect(options.backgroundMessage).toBeUndefined();

    f.emit({ latitude: 10, longitude: 20 });
    expect(onFix).toHaveBeenCalledWith(expect.objectContaining({ lat: 10, lng: 20 }));
  });

  it('reports denied without adding a watcher when permission is refused', async () => {
    const f = fakePlugin();
    const onError = vi.fn();
    await createNativeGeo({ plugin: f.plugin, kind: 'android', ensurePermission: async () => false }).start(vi.fn(), onError);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'denied' }));
    expect(f.addWatcher).not.toHaveBeenCalled();
  });

  it('re-adds the watcher while the plugin service is still binding', async () => {
    const f = fakePlugin();
    const t = manualTimers();
    const onError = vi.fn();
    const onFix = vi.fn();
    await createNativeGeo({ plugin: f.plugin, kind: 'android', ensurePermission: async () => true, ...t }).start(
      onFix,
      onError,
    );
    f.fail('Service not running.');
    expect(onError).not.toHaveBeenCalled();
    t.runAll();
    await Promise.resolve();
    expect(f.addWatcher).toHaveBeenCalledTimes(2);
    f.emit({});
    expect(onFix).toHaveBeenCalledTimes(1);
  });

  it('passes other errors through and keeps the watcher (location services can come back)', async () => {
    const f = fakePlugin();
    const onError = vi.fn();
    await createNativeGeo({ plugin: f.plugin, kind: 'android', ensurePermission: async () => true }).start(vi.fn(), onError);
    f.fail('Location services disabled.', 'NOT_AUTHORIZED');
    expect(onError).toHaveBeenCalledWith({ code: 'unavailable', message: 'Location services are turned off' });
    expect(f.removeWatcher).not.toHaveBeenCalled();
  });

  it('stop() removes the watcher and silences late callbacks', async () => {
    const f = fakePlugin();
    const geo = createNativeGeo({ plugin: f.plugin, kind: 'android', ensurePermission: async () => true });
    const onFix = vi.fn();
    await geo.start(onFix, vi.fn());
    const callback = [...f.watchers.values()][0]!.callback;
    await geo.stop();
    expect(f.removeWatcher).toHaveBeenCalledWith({ id: '1' });
    callback({ latitude: 0, longitude: 0, accuracy: 1, altitude: null, altitudeAccuracy: null, simulated: false, bearing: null, speed: null, time: 1 });
    expect(onFix).not.toHaveBeenCalled();
  });

  it('a stop() during the permission prompt wins', async () => {
    const f = fakePlugin();
    let grant!: (v: boolean) => void;
    const geo = createNativeGeo({
      plugin: f.plugin,
      kind: 'android',
      ensurePermission: () => new Promise<boolean>((r) => (grant = r)),
    });
    const starting = geo.start(vi.fn(), vi.fn());
    await Promise.resolve();
    await geo.stop();
    grant(true);
    await starting;
    expect(f.addWatcher).not.toHaveBeenCalled();
  });
});

describe('createNativeGeo (ios)', () => {
  it('sets backgroundMessage, which enables background updates, and lets the plugin prompt', async () => {
    const f = fakePlugin();
    await createNativeGeo({ plugin: f.plugin, kind: 'ios' }).start(vi.fn(), vi.fn());
    expect(f.addWatcher.mock.calls[0]![0]).toMatchObject({
      backgroundMessage: BACKGROUND_MESSAGE,
      requestPermissions: true,
      distanceFilter: 0,
      stale: false,
    });
  });
});
