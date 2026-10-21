/** Color math for markers and for drawing true colors under the night-mode canvas filter. */

export type Rgb = [number, number, number];

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** "#3d9bff" or "#39f" -> [0..1, 0..1, 0..1]. */
export function parseHex(hex: string): Rgb {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`not a hex color: ${hex}`);
  const h = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join('') : m[1]!;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as Rgb;
}

export function toHex(rgb: Rgb): string {
  return `#${rgb.map((v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/** WCAG relative luminance. */
export function relativeLuminance(hex: string): number {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = parseHex(hex).map(lin) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export const DARK_TEXT = '#0b0d10';
export const LIGHT_TEXT = '#ffffff';

/** White or near-black, whichever contrasts more with `background` (lime and cyan need dark text). */
export function readableTextColor(background: string): string {
  const l = relativeLuminance(background);
  const onWhite = 1.05 / (l + 0.05);
  const onDark = (l + 0.05) / (relativeLuminance(DARK_TEXT) + 0.05);
  return onDark > onWhite ? DARK_TEXT : LIGHT_TEXT;
}

// ---- night filter ---------------------------------------------------------------------------

/**
 * Night mode without a dark style: the day style's canvas is filtered with
 * invert -> hue-rotate(180deg) -> brightness -> contrast -> saturate. Inverting flips light land to
 * dark, the half-turn of hue puts water and parks back near their original hues, and the last three
 * steps take the glare off. Only the canvas is filtered, so DOM markers keep their colors.
 */
export const NIGHT_FILTER = { brightness: 0.9, contrast: 0.9, saturate: 0.7 } as const;

export const NIGHT_CANVAS_FILTER =
  `invert(1) hue-rotate(180deg) brightness(${NIGHT_FILTER.brightness}) ` +
  `contrast(${NIGHT_FILTER.contrast}) saturate(${NIGHT_FILTER.saturate})`;

type Matrix = [Rgb, Rgb, Rgb];

const mul = (m: Matrix, c: Rgb): Rgb => m.map((row) => row[0] * c[0] + row[1] * c[1] + row[2] * c[2]) as Rgb;

/** The CSS Filter Effects hue-rotate matrix at 180 degrees; it is its own inverse. */
const HUE_180: Matrix = [
  [0.213 - 0.787, 0.715 + 0.715, 0.072 + 0.072],
  [0.213 + 0.213, 0.715 - 0.285, 0.072 + 0.072],
  [0.213 + 0.213, 0.715 + 0.715, 0.072 - 0.928],
];

function saturateMatrix(s: number): Matrix {
  return [
    [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s],
    [0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s],
    [0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s],
  ];
}

const clampRgb = (c: Rgb): Rgb => c.map(clamp01) as Rgb;

function nightFilter(input: Rgb): Rgb {
  const { brightness: b, contrast: k, saturate: s } = NIGHT_FILTER;
  let c = input.map((v) => 1 - v) as Rgb;
  c = clampRgb(mul(HUE_180, c));
  c = clampRgb(c.map((v) => v * b) as Rgb);
  c = clampRgb(c.map((v) => v * k + 0.5 - 0.5 * k) as Rgb);
  return clampRgb(mul(saturateMatrix(s), c));
}

/** What the night filter turns `hex` into (browsers apply CSS filter functions in sRGB). */
export function applyNightFilter(hex: string): string {
  return toHex(nightFilter(parseHex(hex)));
}

/**
 * The color to paint inside the filtered canvas so that it *appears* as `hex` (route line, accuracy
 * circle). Starts from the analytic inverse, then refines numerically, because saturated colors lie
 * outside what the filter can output and clamping alone would skew their hue.
 */
export function compensateForNightFilter(hex: string): string {
  const { brightness: b, contrast: k, saturate: s } = NIGHT_FILTER;
  const target = parseHex(hex);
  let guess = mul(saturateMatrix(1 / s), target);
  guess = guess.map((v) => (v - 0.5 + 0.5 * k) / k) as Rgb;
  guess = clampRgb(guess.map((v) => v / b) as Rgb);
  guess = clampRgb(mul(HUE_180, guess).map((v) => 1 - v) as Rgb);

  const error = (c: Rgb) => nightFilter(c).reduce((sum, v, i) => sum + (v - target[i]!) ** 2, 0);
  let best = guess;
  let bestError = error(best);
  for (let step = 0.25; step > 1 / 2048; step /= 2) {
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 0; i < 3; i++) {
        for (const d of [-step, step]) {
          const c = [...best] as Rgb;
          c[i] = clamp01(c[i]! + d);
          const e = error(c);
          if (e < bestError) {
            best = c;
            bestError = e;
            improved = true;
          }
        }
      }
    }
  }
  return toHex(best);
}
