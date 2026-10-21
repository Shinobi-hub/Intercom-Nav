// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { isNightHour, planTheme, wantsNight } from './theme';

const at = (h: number, m = 0) => new Date(2026, 9, 19, h, m);

describe('night theme', () => {
  it('auto is night from 19:00 until 06:00 local time', () => {
    expect(isNightHour(at(18, 59))).toBe(false);
    expect(isNightHour(at(19, 0))).toBe(true);
    expect(isNightHour(at(0, 30))).toBe(true);
    expect(isNightHour(at(5, 59))).toBe(true);
    expect(isNightHour(at(6, 0))).toBe(false);
    expect(isNightHour(at(12, 0))).toBe(false);
  });

  it('respects explicit day and night settings', () => {
    expect(wantsNight('night', at(12))).toBe(true);
    expect(wantsNight('day', at(23))).toBe(false);
    expect(wantsNight('auto', at(23))).toBe(true);
    expect(wantsNight('auto', at(9))).toBe(false);
  });

  it('filters the day style when no night style is configured', () => {
    expect(planTheme(true, 'day.json', null, false)).toEqual({ night: true, styleUrl: 'day.json', canvasFilter: true });
    expect(planTheme(false, 'day.json', null, false)).toEqual({ night: false, styleUrl: 'day.json', canvasFilter: false });
  });

  it('switches to the night style when there is one, and filters the offline fallback instead', () => {
    expect(planTheme(true, 'day.json', 'night.json', false)).toEqual({
      night: true,
      styleUrl: 'night.json',
      canvasFilter: false,
    });
    expect(planTheme(true, 'day.json', 'night.json', true).canvasFilter).toBe(true);
    expect(planTheme(false, 'day.json', 'night.json', true).canvasFilter).toBe(false);
  });
});
