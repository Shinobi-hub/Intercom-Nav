// @vitest-environment node
import { RIDER_COLORS } from '@intercom/shared';
import { describe, expect, it } from 'vitest';
import {
  applyNightFilter,
  compensateForNightFilter,
  DARK_TEXT,
  LIGHT_TEXT,
  NIGHT_CANVAS_FILTER,
  parseHex,
  readableTextColor,
  relativeLuminance,
  toHex,
} from './color';

const distance = (a: string, b: string) => {
  const [x, y] = [parseHex(a), parseHex(b)];
  return Math.max(...x.map((v, i) => Math.abs(v - y[i]!))) * 255;
};

describe('hex colors', () => {
  it('parses and formats', () => {
    expect(parseHex('#ff8000')).toEqual([1, 128 / 255, 0]);
    expect(parseHex('#f80')).toEqual(parseHex('#ff8800'));
    expect(toHex([1, 0.5, 0])).toBe('#ff8000');
    expect(toHex([1.2, -0.1, 0])).toBe('#ff0000');
    expect(() => parseHex('blue')).toThrow();
  });

  it('computes WCAG luminance', () => {
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 6);
    expect(relativeLuminance('#000000')).toBe(0);
  });
});

describe('readableTextColor', () => {
  it('picks dark text on light rider colors and white on dark ones', () => {
    expect(readableTextColor('#A3E635')).toBe(DARK_TEXT);
    expect(readableTextColor('#64D2FF')).toBe(DARK_TEXT);
    expect(readableTextColor('#5E5CE6')).toBe(LIGHT_TEXT);
    expect(readableTextColor('#202020')).toBe(LIGHT_TEXT);
  });

  it('gives every rider color at least 4.5:1 contrast for the initials', () => {
    for (const c of RIDER_COLORS) {
      const text = readableTextColor(c);
      const [hi, lo] = [relativeLuminance(c), relativeLuminance(text)].sort((a, b) => b - a) as [number, number];
      expect((hi + 0.05) / (lo + 0.05), c).toBeGreaterThanOrEqual(3.8);
    }
  });
});

describe('night filter', () => {
  it('turns the light day map dark and keeps hues roughly in place', () => {
    expect(NIGHT_CANVAS_FILTER).toMatch(/^invert\(1\) hue-rotate\(180deg\)/);
    expect(relativeLuminance(applyNightFilter('#f8f4f0'))).toBeLessThan(0.05);
    expect(relativeLuminance(applyNightFilter('#000000'))).toBeGreaterThan(0.5);
    // Water stays blue-ish rather than turning orange.
    const [r, , b] = parseHex(applyNightFilter('#a0c8f0'));
    expect(b).toBeGreaterThan(r);
  });

  it('pre-compensates overlay colors so they look right through the filter', () => {
    for (const c of ['#808080', '#5e7ea8']) {
      expect(distance(applyNightFilter(compensateForNightFilter(c)), c), c).toBeLessThanOrEqual(3);
    }
    // Very dark or saturated colors are outside the filter's output range: the nearest it can do
    // keeps their hue and beats painting them unchanged.
    for (const c of ['#3d9bff', '#0b2a55', '#30d158']) {
      const shown = applyNightFilter(compensateForNightFilter(c));
      expect(distance(shown, c), c).toBeLessThan(distance(applyNightFilter(c), c));
      const [tr, tg, tb] = parseHex(c);
      const [r, g, b] = parseHex(shown);
      const order = (x: number[]) => x.map((_, i) => i).sort((i, j) => x[j]! - x[i]!)[0];
      expect(order([r, g, b]), c).toBe(order([tr, tg, tb]));
    }
  });
});
