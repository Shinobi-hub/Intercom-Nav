// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { boundsOf, groupPadding, needsRefit, type Bounds } from './camera';

const box = (west: number, south: number, east: number, north: number): Bounds => ({ west, south, east, north });

describe('boundsOf', () => {
  it('is null for no points and the min/max box otherwise', () => {
    expect(boundsOf([])).toBeNull();
    expect(
      boundsOf([
        { lat: 18.5, lng: 73.8 },
        { lat: 18.6, lng: 73.7 },
        { lat: 18.55, lng: 73.9 },
      ]),
    ).toEqual(box(73.7, 18.5, 73.9, 18.6));
  });
});

describe('needsRefit', () => {
  const fitted = box(73.8, 18.5, 73.9, 18.6);

  it('always fits the first time', () => {
    expect(needsRefit(null, fitted)).toBe(true);
  });

  it('ignores small changes inside the fitted area', () => {
    expect(needsRefit(fitted, fitted)).toBe(false);
    expect(needsRefit(fitted, box(73.81, 18.51, 73.905, 18.6))).toBe(false);
    expect(needsRefit(fitted, box(73.8, 18.5, 73.9, 18.55))).toBe(false); // shrank on one axis only
  });

  it('refits when someone moves out of the fitted area', () => {
    expect(needsRefit(fitted, box(73.8, 18.5, 73.92, 18.6))).toBe(true);
    expect(needsRefit(fitted, box(73.8, 18.48, 73.9, 18.6))).toBe(true);
  });

  it('refits to zoom back in when the group bunches up', () => {
    expect(needsRefit(fitted, box(73.84, 18.54, 73.88, 18.58))).toBe(true);
  });

  it('does not chase GPS jitter of a tightly bunched group', () => {
    const tight = box(73.85, 18.55, 73.8501, 18.5501);
    expect(needsRefit(tight, box(73.85005, 18.55005, 73.85015, 18.55015))).toBe(false);
  });
});

describe('groupPadding', () => {
  it('leaves room for the dock below in portrait and at the sides in landscape', () => {
    const portrait = groupPadding(390, 844);
    expect(portrait.bottom).toBeGreaterThan(portrait.top);
    expect(portrait.bottom).toBeGreaterThan(portrait.left);
    const landscape = groupPadding(844, 390);
    expect(landscape.left).toBeGreaterThan(landscape.top);
    expect(landscape.right).toBeGreaterThan(landscape.bottom);
  });

  it('never takes more than 60% of a small window', () => {
    const p = groupPadding(200, 250);
    expect(p.left + p.right).toBeLessThanOrEqual(120.0001);
    expect(p.top + p.bottom).toBeLessThanOrEqual(150.0001);
  });
});
