import type { LatLng } from '@intercom/shared';

type CenterSource = () => LatLng | null;

let source: CenterSource | null = null;

/** Called by the live map while it is mounted. Returns an unregister function. */
export function provideMapCenter(fn: CenterSource): () => void {
  source = fn;
  return () => {
    if (source === fn) source = null;
  };
}

/** Center of the map on screen right now, or null when no map is mounted. */
export function getMapCenter(): LatLng | null {
  return source?.() ?? null;
}
