import type { MapTheme } from '../../core/store';

/** 'auto' switches to night at 19:00 and back to day at 06:00, local time. */
export const NIGHT_FROM_HOUR = 19;
export const NIGHT_UNTIL_HOUR = 6;

export function isNightHour(date: Date): boolean {
  const h = date.getHours();
  return h >= NIGHT_FROM_HOUR || h < NIGHT_UNTIL_HOUR;
}

export function wantsNight(theme: MapTheme, date: Date = new Date()): boolean {
  return theme === 'night' || (theme === 'auto' && isNightHour(date));
}

export interface ThemePlan {
  night: boolean;
  /** Style URL to load. */
  styleUrl: string;
  /** Darken the day style with the canvas filter (no night style configured, or offline fallback). */
  canvasFilter: boolean;
}

export function planTheme(
  night: boolean,
  dayStyle: string,
  nightStyle: string | null,
  usingFallback: boolean,
): ThemePlan {
  const styleUrl = night && nightStyle ? nightStyle : dayStyle;
  return { night, styleUrl, canvasFilter: night && (!nightStyle || usingFallback) };
}
