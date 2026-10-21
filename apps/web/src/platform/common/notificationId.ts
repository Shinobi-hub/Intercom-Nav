/**
 * Notification id of the Android "ride in progress" foreground service (RideService.java,
 * NOTIFICATION_ID). Alert notifications must never reuse it or they would replace that notification.
 */
export const RIDE_SERVICE_NOTIFICATION_ID = 0x52494445;

/**
 * Stable, positive 31-bit id for a string alert id. Android and @capacitor/local-notifications need
 * an int; deriving it from the alert id means re-notifying the same alert replaces the old one
 * instead of stacking duplicates. FNV-1a, so it's cheap and well spread.
 */
export function notificationIdFor(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const id = h & 0x7fffffff;
  return id === 0 || id === RIDE_SERVICE_NOTIFICATION_ID ? 1 : id;
}
