import type { LngLatTuple } from '@intercom/shared';

/**
 * Decodes an encoded polyline (Google's algorithm) into [lng, lat] pairs. Valhalla uses
 * precision 6, Google and OSRM's `polyline` geometry precision 5. Arithmetic stays in doubles
 * rather than 32-bit bit operations, so no precision can overflow.
 */
export function decodePolyline(encoded: string, precision = 6): LngLatTuple[] {
  const factor = 10 ** precision;
  const coords: LngLatTuple[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  const readValue = (): number => {
    let result = 0;
    let multiplier = 1;
    let chunk: number;
    do {
      if (index >= encoded.length) throw new Error('Truncated polyline');
      chunk = encoded.charCodeAt(index++) - 63;
      if (chunk < 0 || chunk > 63) throw new Error('Invalid polyline character');
      result += (chunk & 0x1f) * multiplier;
      multiplier *= 32;
      if (multiplier > 2 ** 50) throw new Error('Polyline value out of range');
    } while (chunk >= 0x20);
    // Zigzag: odd values are negative.
    return result % 2 === 1 ? -(result + 1) / 2 : result / 2;
  };

  while (index < encoded.length) {
    lat += readValue();
    lng += readValue();
    coords.push([lng / factor, lat / factor]);
  }
  return coords;
}

/** Inverse of decodePolyline; takes [lng, lat] pairs. */
export function encodePolyline(coords: readonly (readonly [number, number])[], precision = 6): string {
  const factor = 10 ** precision;
  let out = '';
  let prevLat = 0;
  let prevLng = 0;

  const writeValue = (delta: number) => {
    let v = delta < 0 ? -delta * 2 - 1 : delta * 2;
    while (v >= 0x20) {
      out += String.fromCharCode(((v % 32) | 0x20) + 63);
      v = Math.floor(v / 32);
    }
    out += String.fromCharCode(v + 63);
  };

  for (const [lng, lat] of coords) {
    const iLat = Math.round(lat * factor);
    const iLng = Math.round(lng * factor);
    writeValue(iLat - prevLat);
    writeValue(iLng - prevLng);
    prevLat = iLat;
    prevLng = iLng;
  }
  return out;
}
