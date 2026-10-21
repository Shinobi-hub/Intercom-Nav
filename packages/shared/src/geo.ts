export interface LatLng {
  lat: number;
  lng: number;
}

/** [lng, lat], the GeoJSON / MapLibre coordinate order. */
export type LngLatTuple = [number, number];

export const EARTH_RADIUS_M = 6_371_008.8;

const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Wraps any angle into [0, 360). */
export function normalizeDeg(d: number): number {
  const r = d % 360;
  return r < 0 ? r + 360 : r;
}

/** Wraps longitude into [-180, 180). */
export function normalizeLng(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

/** Signed shortest rotation from `from` to `to`, in (-180, 180]. */
export function angleDiffDeg(from: number, to: number): number {
  const d = normalizeDeg(to - from);
  return d > 180 ? d - 360 : d;
}

/** Interpolates headings the short way round (350 -> 10 passes through 0). */
export function lerpAngleDeg(a: number, b: number, t: number): number {
  return normalizeDeg(a + angleDiffDeg(a, b) * t);
}

/** Great-circle distance in meters. */
export function haversineM(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial bearing from `from` to `to`, degrees clockwise from north in [0, 360). */
export function bearingDeg(from: LatLng, to: LatLng): number {
  const phi1 = toRad(from.lat);
  const phi2 = toRad(to.lat);
  const dLambda = toRad(to.lng - from.lng);
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return normalizeDeg(toDeg(Math.atan2(y, x)));
}

/** The point `distanceM` meters from `from` along initial bearing `bearing`. */
export function destinationPoint(from: LatLng, bearing: number, distanceM: number): LatLng {
  const delta = distanceM / EARTH_RADIUS_M;
  const theta = toRad(bearing);
  const phi1 = toRad(from.lat);
  const lambda1 = toRad(from.lng);
  const sinPhi2 = Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta);
  const phi2 = Math.asin(sinPhi2);
  const y = Math.sin(theta) * Math.sin(delta) * Math.cos(phi1);
  const x = Math.cos(delta) - Math.sin(phi1) * sinPhi2;
  return { lat: toDeg(phi2), lng: normalizeLng(toDeg(lambda1 + Math.atan2(y, x))) };
}

/** Total length of a [lng, lat] polyline in meters. */
export function polylineLengthM(coords: ReadonlyArray<readonly [number, number]>): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1]!;
    const b = coords[i]!;
    total += haversineM({ lng: a[0], lat: a[1] }, { lng: b[0], lat: b[1] });
  }
  return total;
}
