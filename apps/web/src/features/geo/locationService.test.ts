import { destinationPoint, haversineM, TIMING, type LocationFix } from '@intercom/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installDebugGlobal } from '../../core/debug';
import type { GeoError, GeoProvider, RawFix } from '../../core/services';
import { useLocalStore } from '../../core/store';
import { createLocationService, HEARTBEAT_MAX_FIX_AGE_MS } from './locationService';
import { rawFix } from './testing';

const HOME = { lat: 18.52, lng: 73.85 };
const NOW = 1_700_000_000_000;

function fakeProvider() {
  const sessions: { onFix: (f: RawFix) => void; onError: (e: GeoError) => void }[] = [];
  const geo = {
    start: vi.fn<GeoProvider['start']>(async (onFix, onError) => {
      sessions.push({ onFix, onError });
    }),
    stop: vi.fn<GeoProvider['stop']>(async () => {}),
  };
  return {
    geo,
    /** Deliver a fix through the most recent provider session. */
    fix: (f: RawFix) => sessions.at(-1)?.onFix(f),
    error: (e: GeoError) => sessions.at(-1)?.onError(e),
    sessions,
  };
}

/** A good fix `meters` north of HOME, stamped with the (fake) current time. */
const here = (meters = 0, extra: Partial<RawFix> = {}) =>
  rawFix({ ...destinationPoint(HOME, 0, meters), timestamp: Date.now(), ...extra });

const gps = () => useLocalStore.getState().gps;

function setup() {
  const provider = fakeProvider();
  const service = createLocationService({ geo: provider.geo });
  const sent: LocationFix[] = [];
  const fixes: LocationFix[] = [];
  service.onSend((f) => sent.push(f));
  service.onFix((f) => fixes.push(f));
  return { provider, service, sent, fixes };
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  useLocalStore.getState().reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('location service', () => {
  it('publishes GPS status and the processed fix', async () => {
    const { provider, service, sent, fixes } = setup();
    const starting = service.start();
    expect(gps().status).toBe('starting');
    await starting;
    expect(provider.geo.start).toHaveBeenCalledTimes(1);

    provider.fix(here(0, { accuracy: 7, speed: 4, heading: 90, altitude: 560.123 }));
    expect(gps()).toEqual({ status: 'active', accuracyM: 7, lastFixAt: NOW, error: null });
    const self = useLocalStore.getState().selfFix!;
    expect(self).toMatchObject({ lat: HOME.lat, lng: HOME.lng, acc: 7, spd: 4, hdg: 90, alt: 560.1, t: NOW });
    expect(fixes).toEqual([self]);
    expect(sent).toEqual([self]);
  });

  it('drops filtered fixes without publishing them', async () => {
    const { provider, service, fixes } = setup();
    await service.start();
    provider.fix(here(0, { accuracy: 90 }));
    expect(fixes).toHaveLength(0);
    expect(gps().status).toBe('starting');
    expect(useLocalStore.getState().selfFix).toBeNull();
  });

  it('smooths positions instead of passing raw fixes through', async () => {
    const { provider, service } = setup();
    await service.start();
    provider.fix(here(0, { speed: 0 }));
    vi.advanceTimersByTime(1000);
    provider.fix(here(6, { speed: 0 }));
    const d = haversineM(HOME, useLocalStore.getState().selfFix!);
    expect(d).toBeGreaterThan(0.5);
    expect(d).toBeLessThan(5);
  });

  it('applies the send policy to a stationary rider', async () => {
    const { provider, service, sent } = setup();
    await service.start();
    for (let s = 0; s <= 6; s++) {
      provider.fix(here(0.5 * (s % 2), { speed: 0 }));
      vi.advanceTimersByTime(1000);
    }
    // First fix, then the 5 s heartbeat rule; the jitter is below the 5 m threshold.
    expect(sent.map((f) => f.t - NOW)).toEqual([0, TIMING.locHeartbeatMs]);
  });

  it('sends every fix of a rider moving more than 5 m between fixes', async () => {
    const { provider, service, sent } = setup();
    await service.start();
    for (let s = 0; s < 5; s++) {
      provider.fix(here(s * 20, { speed: 20, heading: 0 }));
      vi.advanceTimersByTime(1000);
    }
    expect(sent).toHaveLength(5);
  });

  it('re-sends the newest fix as a heartbeat when the provider goes quiet, until it is 30 s old', async () => {
    const { provider, service, sent } = setup();
    await service.start();
    provider.fix(here());
    vi.advanceTimersByTime(HEARTBEAT_MAX_FIX_AGE_MS + 20_000);
    const offsets = sent.map((f) => f.t - NOW);
    expect(offsets).toEqual([0, 5_000, 10_000, 15_000, 20_000, 25_000]);
    for (const f of sent) expect(f).toMatchObject({ lat: sent[0]!.lat, lng: sent[0]!.lng });

    // A fresh fix revives the heartbeat.
    provider.fix(here());
    vi.advanceTimersByTime(TIMING.locHeartbeatMs);
    expect(sent).toHaveLength(8);
  });

  it('does not run the heartbeat while stopped, but inject() still works', () => {
    const { service, sent } = setup();
    service.inject(here());
    expect(sent).toHaveLength(1);
    expect(gps().status).toBe('active');
    vi.advanceTimersByTime(30_000);
    expect(sent).toHaveLength(1);
  });

  it('keeps sent timestamps strictly increasing when a provider fix arrives after a heartbeat', async () => {
    const { provider, service, sent } = setup();
    await service.start();
    provider.fix(here());
    vi.advanceTimersByTime(TIMING.locHeartbeatMs); // heartbeat stamped NOW + 5000
    vi.advanceTimersByTime(600);
    // Taken before the heartbeat, delivered after it.
    provider.fix(here(60, { timestamp: NOW + 4_500 }));
    expect(sent).toHaveLength(3);
    expect(sent[2]!.t).toBe(sent[1]!.t + 1);
  });

  it('stops the provider and ignores its late callbacks', async () => {
    const { provider, service, fixes } = setup();
    await service.start();
    const stale = provider.sessions[0]!;
    await service.stop();
    expect(provider.geo.stop).toHaveBeenCalledTimes(1);
    expect(gps().status).toBe('off');
    stale.onFix(here());
    stale.onError({ code: 'denied', message: 'late' });
    expect(fixes).toHaveLength(0);
    expect(gps().status).toBe('off');
  });

  it('is idempotent while running and restarts the provider after a failure', async () => {
    const { provider, service } = setup();
    await service.start();
    await service.start();
    expect(provider.geo.start).toHaveBeenCalledTimes(1);

    provider.error({ code: 'unavailable', message: 'no signal' });
    expect(gps()).toMatchObject({ status: 'unavailable', error: 'no signal' });
    await service.start();
    expect(provider.geo.stop).toHaveBeenCalledTimes(1);
    expect(provider.geo.start).toHaveBeenCalledTimes(2);
    expect(gps().status).toBe('starting');
  });

  it('maps provider errors to GPS states', async () => {
    const { provider, service } = setup();
    await service.start();
    provider.error({ code: 'timeout', message: '' });
    expect(gps()).toMatchObject({ status: 'unavailable', error: 'No GPS signal' });

    provider.fix(here());
    provider.error({ code: 'timeout', message: 'slow' });
    expect(gps()).toMatchObject({ status: 'active', error: 'slow' });

    provider.error({ code: 'unknown', message: 'boom' });
    expect(gps()).toMatchObject({ status: 'error', error: 'boom' });

    provider.error({ code: 'denied', message: '' });
    expect(gps()).toMatchObject({ status: 'denied', error: 'Location permission denied' });
  });

  it('reports a provider that fails to start instead of throwing', async () => {
    const { provider, service } = setup();
    provider.geo.start.mockRejectedValueOnce({ code: 'denied', message: 'User denied Geolocation' });
    await expect(service.start()).resolves.toBeUndefined();
    expect(gps()).toMatchObject({ status: 'denied', error: 'User denied Geolocation' });

    provider.geo.start.mockRejectedValueOnce(new Error('plugin missing'));
    await service.start();
    expect(gps()).toMatchObject({ status: 'error', error: 'plugin missing' });
  });

  it('restarts smoothing after a confirmed jump instead of blending across it', async () => {
    const { provider, service } = setup();
    await service.start();
    provider.fix(here());
    for (let i = 1; i <= 3; i++) {
      vi.advanceTimersByTime(1000);
      provider.fix(here(10_000 + i * 15, { speed: 15 }));
    }
    const self = useLocalStore.getState().selfFix!;
    expect(haversineM(self, destinationPoint(HOME, 0, 10_045))).toBeLessThan(1);
  });

  it('isolates listeners from each other and supports unsubscribing', () => {
    const { service } = setup();
    const bad = vi.fn(() => {
      throw new Error('listener bug');
    });
    const good = vi.fn();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const off = service.onFix(bad);
    service.onFix(good);
    service.inject(here());
    expect(good).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalled();
    off();
    vi.advanceTimersByTime(1000);
    service.inject(here(10));
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(2);
    errors.mockRestore();
  });

  it('exposes inject and lastSent as debug hooks', () => {
    const { sent } = setup();
    installDebugGlobal();
    const geo = window.__intercom!.geo!;
    geo.inject({ lat: HOME.lat, lng: HOME.lng });
    // Same millisecond: still accepted (timestamps are bumped), but not sent (min interval).
    geo.inject({ lat: HOME.lat + 0.00001, lng: HOME.lng });
    expect(useLocalStore.getState().selfFix!.t).toBe(NOW + 1);
    expect(useLocalStore.getState().selfFix!.acc).toBe(5);
    expect(sent).toHaveLength(1);
    expect(geo.lastSent()).toEqual(sent[0]);
  });
});
