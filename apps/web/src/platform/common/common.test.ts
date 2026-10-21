// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { notificationIdFor, RIDE_SERVICE_NOTIFICATION_ID } from './notificationId';
import { compactShareData, isSafeExternalUrl } from './urls';
import { toVibrationSegments } from './vibration';

describe('toVibrationSegments', () => {
  it('turns a single duration into one pulse', () => {
    expect(toVibrationSegments(120)).toEqual([{ at: 0, duration: 120 }]);
  });

  it('alternates on/off steps', () => {
    expect(toVibrationSegments([200, 100, 200])).toEqual([
      { at: 0, duration: 200 },
      { at: 300, duration: 200 },
    ]);
  });

  it('treats 0, [] and junk as "stop"', () => {
    expect(toVibrationSegments(0)).toEqual([]);
    expect(toVibrationSegments([])).toEqual([]);
    expect(toVibrationSegments([NaN, -5])).toEqual([]);
  });

  it('caps absurd durations', () => {
    expect(toVibrationSegments(60_000)).toEqual([{ at: 0, duration: 5_000 }]);
  });
});

describe('notificationIdFor', () => {
  it('is stable, positive and 31-bit', () => {
    const id = notificationIdFor('sos-3f0c');
    expect(id).toBe(notificationIdFor('sos-3f0c'));
    expect(id).toBeGreaterThan(0);
    expect(id).toBeLessThanOrEqual(0x7fffffff);
  });

  it('spreads different alert ids', () => {
    const ids = new Set(Array.from({ length: 1000 }, (_, i) => notificationIdFor(`break-${i}`)));
    expect(ids.size).toBe(1000);
    expect(ids.has(RIDE_SERVICE_NOTIFICATION_ID)).toBe(false);
  });
});

describe('isSafeExternalUrl', () => {
  it('allows maps links and blocks script/data URLs', () => {
    expect(isSafeExternalUrl('https://www.google.com/maps/dir/?api=1&destination=1,2')).toBe(true);
    expect(isSafeExternalUrl('geo:52.1,4.3')).toBe(true);
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeExternalUrl('data:text/html,hi')).toBe(false);
    expect(isSafeExternalUrl('not a url')).toBe(false);
  });

  it('compactShareData drops empty fields', () => {
    expect(compactShareData({ title: 'Ride', url: undefined, text: '' })).toEqual({ title: 'Ride' });
  });
});
