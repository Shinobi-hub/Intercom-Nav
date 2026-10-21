/** Helpers shared by the web and native GeoProviders to normalise raw OS positions. */

/** Used when the OS gives no horizontal accuracy: large enough that the location filter treats it as poor. */
export const UNKNOWN_ACCURACY_M = 9_999;

export function finiteOrNull(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Speed in m/s, or null when missing or negative (iOS reports -1 for "invalid"). */
export function speedOrNull(v: number | null | undefined): number | null {
  const n = finiteOrNull(v);
  return n !== null && n >= 0 ? n : null;
}

/** Heading in [0, 360), or null when missing or negative (iOS reports -1 for "invalid"). */
export function headingOrNull(v: number | null | undefined): number | null {
  const n = finiteOrNull(v);
  if (n === null || n < 0) return null;
  return n % 360;
}

export function accuracyOrUnknown(v: number | null | undefined): number {
  const n = finiteOrNull(v);
  return n !== null && n >= 0 ? n : UNKNOWN_ACCURACY_M;
}
