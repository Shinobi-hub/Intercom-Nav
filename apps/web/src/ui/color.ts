import { RIDER_COLORS } from '@intercom/shared';

const NAMES: Record<string, string> = {
  '#0a84ff': 'Blue',
  '#30d158': 'Green',
  '#bf5af2': 'Purple',
  '#64d2ff': 'Cyan',
  '#5e5ce6': 'Indigo',
  '#00c7be': 'Teal',
  '#ff6fd8': 'Pink',
  '#a3e635': 'Lime',
};

export const riderColorName = (hex: string): string => NAMES[hex.toLowerCase()] ?? 'Custom';

export const sameColor = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export const isRiderColor = (hex: string): boolean => RIDER_COLORS.some((c) => sameColor(c, hex));

/** WCAG relative luminance of a #rrggbb color. */
export function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0;
  const n = parseInt(m[1]!, 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

/** Black or white, whichever reads better on `hex` (crossover at luminance ≈ 0.18). */
export function inkOn(hex: string): string {
  return luminance(hex) > 0.179 ? '#0b0d10' : '#ffffff';
}
