import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GeoError, RawFix } from '../../core/services';
import { createWebGeo, mapGeoError, positionToRawFix, WEB_GEO_OPTIONS } from './geo';

type Success = PositionCallback;
type Failure = PositionErrorCallback;

/** Fake navigator.geolocation that lets the test fire callbacks for the most recent watch. */
function fakeGeolocation() {
  let nextId = 1;
  const watches = new Map<number, { success: Success; failure: Failure; options?: PositionOptions }>();
  const geo = {
    watchPosition: vi.fn((success: Success, failure?: Failure | null, options?: PositionOptions) => {
      const id = nextId++;
      watches.set(id, { success, failure: failure ?? (() => {}), options });
      return id;
    }),
    clearWatch: vi.fn((id: number) => {
      watches.delete(id);
    }),
    getCurrentPosition: vi.fn(),
  };
  const latest = () => {
    const ids = [...watches.keys()];
    const id = ids[ids.length - 1];
    if (id === undefined) throw new Error('no active watch');
    return watches.get(id)!;
  };
  return {
    geo: geo as unknown as Geolocation,
    spies: geo,
    active: () => watches.size,
    emitFix: (coords: Partial<GeolocationCoordinates>, timestamp = 1_700_000_000_000) =>
      latest().success({ coords: { accuracy: 5, ...coords } as GeolocationCoordinates, timestamp } as GeolocationPosition),
    emitError: (code: number, message = '') =>
      latest().failure({ code, message, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError),
  };
}

describe('mapGeoError', () => {
  it('maps the spec error codes', () => {
    expect(mapGeoError({ code: 1, message: 'User denied Geolocation' })).toEqual({
      code: 'denied',
      message: 'User denied Geolocation',
    });
    expect(mapGeoError({ code: 2 }).code).toBe('unavailable');
    expect(mapGeoError({ code: 3 }).code).toBe('timeout');
    expect(mapGeoError({ code: 42 }).code).toBe('unknown');
    expect(mapGeoError(null).code).toBe('unknown');
  });

  it('fills in a message when the browser gives none', () => {
    expect(mapGeoError({ code: 1, message: '  ' }).message).toMatch(/denied/i);
  });
});

describe('positionToRawFix', () => {
  it('normalises missing, negative and NaN fields to null', () => {
    const fix = positionToRawFix({
      coords: { latitude: 52.1, longitude: 4.3, accuracy: 7, speed: -1, heading: NaN, altitude: null },
      timestamp: 123,
    } as unknown as GeolocationPosition);
    expect(fix).toEqual<RawFix>({
      lat: 52.1,
      lng: 4.3,
      accuracy: 7,
      speed: null,
      heading: null,
      altitude: null,
      timestamp: 123,
    });
  });

  it('keeps valid speed, heading and altitude', () => {
    const fix = positionToRawFix({
      coords: { latitude: 1, longitude: 2, accuracy: 3, speed: 12.5, heading: 270, altitude: 40 },
      timestamp: 5,
    } as unknown as GeolocationPosition);
    expect(fix).toMatchObject({ speed: 12.5, heading: 270, altitude: 40 });
  });
});

describe('createWebGeo', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('watches with high accuracy, no cached fixes and a 20 s timeout', async () => {
    const f = fakeGeolocation();
    await createWebGeo(() => f.geo).start(vi.fn(), vi.fn());
    expect(f.spies.watchPosition).toHaveBeenCalledTimes(1);
    expect(f.spies.watchPosition.mock.calls[0]![2]).toEqual(WEB_GEO_OPTIONS);
    expect(WEB_GEO_OPTIONS).toEqual({ enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 });
  });

  it('delivers fixes', async () => {
    const f = fakeGeolocation();
    const onFix = vi.fn();
    await createWebGeo(() => f.geo).start(onFix, vi.fn());
    f.emitFix({ latitude: 10, longitude: 20, accuracy: 4 });
    expect(onFix).toHaveBeenCalledWith(expect.objectContaining({ lat: 10, lng: 20, accuracy: 4 }));
  });

  it('reports a timeout but keeps watching (re-arms immediately)', async () => {
    const f = fakeGeolocation();
    const onError = vi.fn<(e: GeoError) => void>();
    const onFix = vi.fn();
    await createWebGeo(() => f.geo).start(onFix, onError);

    f.emitError(3, 'Timeout expired');
    expect(onError).toHaveBeenCalledWith({ code: 'timeout', message: 'Timeout expired' });
    vi.advanceTimersByTime(0);
    expect(f.spies.watchPosition).toHaveBeenCalledTimes(2);
    expect(f.active()).toBe(1); // the old watch was cleared, not leaked

    f.emitFix({ latitude: 1, longitude: 1 });
    expect(onFix).toHaveBeenCalledTimes(1);
  });

  it('retries an unavailable position after a pause, not in a hot loop', async () => {
    const f = fakeGeolocation();
    const onError = vi.fn();
    await createWebGeo(() => f.geo).start(vi.fn(), onError);
    f.emitError(2);
    expect(onError).toHaveBeenLastCalledWith(expect.objectContaining({ code: 'unavailable' }));
    vi.advanceTimersByTime(4_999);
    expect(f.spies.watchPosition).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(f.spies.watchPosition).toHaveBeenCalledTimes(2);
  });

  it('stops for good when permission is denied', async () => {
    const f = fakeGeolocation();
    const onError = vi.fn();
    await createWebGeo(() => f.geo).start(vi.fn(), onError);
    f.emitError(1, 'denied');
    expect(onError).toHaveBeenCalledWith({ code: 'denied', message: 'denied' });
    vi.advanceTimersByTime(60_000);
    expect(f.spies.watchPosition).toHaveBeenCalledTimes(1);
    expect(f.active()).toBe(0);
  });

  it('stop() clears the watch and cancels a pending retry', async () => {
    const f = fakeGeolocation();
    const geo = createWebGeo(() => f.geo);
    await geo.start(vi.fn(), vi.fn());
    f.emitError(2);
    await geo.stop();
    vi.advanceTimersByTime(60_000);
    expect(f.spies.watchPosition).toHaveBeenCalledTimes(1);
    expect(f.active()).toBe(0);
  });

  it('ignores callbacks from a previous session', async () => {
    const f = fakeGeolocation();
    const geo = createWebGeo(() => f.geo);
    const first = vi.fn();
    await geo.start(first, vi.fn());
    const stale = f.spies.watchPosition.mock.calls[0]![0];
    const second = vi.fn();
    await geo.start(second, vi.fn());
    stale({ coords: { latitude: 0, longitude: 0, accuracy: 1 }, timestamp: 1 } as GeolocationPosition);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(f.active()).toBe(1);
  });

  it('reports unavailable when the browser has no geolocation', async () => {
    const onError = vi.fn();
    await createWebGeo(() => undefined).start(vi.fn(), onError);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'unavailable' }));
  });
});
