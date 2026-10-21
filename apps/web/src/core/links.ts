import type { LatLng } from '@intercom/shared';

/** Turn-by-turn directions in the platform's maps app. Google's universal link works everywhere. */
export function directionsUrl(to: LatLng, platform: 'web' | 'android' | 'ios'): string {
  const dest = `${to.lat.toFixed(6)},${to.lng.toFixed(6)}`;
  if (platform === 'ios') return `https://maps.apple.com/?daddr=${dest}&dirflg=d`;
  return `https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=driving`;
}

/** Link other riders open to join. */
export function rideJoinUrl(code: string, origin: string = window.location.origin): string {
  return `${origin}/r/${code}`;
}
