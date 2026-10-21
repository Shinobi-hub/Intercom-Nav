/**
 * Per-device rider identity. The id is public (other riders see it); the secret never leaves
 * this device except to the server, which uses it to let only this device reclaim the rider slot.
 */
import { isValidRideCode, randomSecret, RIDER_SECRET_MIN, uuid } from '@intercom/shared';

export interface RiderIdentity {
  id: string;
  secret: string;
}

const IDENTITY_KEY = 'intercom:identity';
const LAST_RIDE_KEY = 'intercom:lastRide';
/** A ride left more than this long ago isn't offered for rejoin. */
const RESUME_WINDOW_MS = 6 * 60 * 60_000;

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: identity lasts for this page load only */
  }
}

let cached: RiderIdentity | null = null;

export function getIdentity(): RiderIdentity {
  if (cached) return cached;
  try {
    const parsed = JSON.parse(read(IDENTITY_KEY) ?? 'null') as Partial<RiderIdentity> | null;
    if (parsed && typeof parsed.id === 'string' && typeof parsed.secret === 'string' && parsed.secret.length >= RIDER_SECRET_MIN) {
      cached = { id: parsed.id, secret: parsed.secret };
      return cached;
    }
  } catch {
    /* fall through and mint a new identity */
  }
  cached = { id: uuid(), secret: randomSecret() };
  write(IDENTITY_KEY, JSON.stringify(cached));
  return cached;
}

export function getLastRide(): string | null {
  try {
    const parsed = JSON.parse(read(LAST_RIDE_KEY) ?? 'null') as { code?: string; at?: number } | null;
    if (!parsed?.code || !isValidRideCode(parsed.code) || typeof parsed.at !== 'number') return null;
    return Date.now() - parsed.at < RESUME_WINDOW_MS ? parsed.code : null;
  } catch {
    return null;
  }
}

export function setLastRide(code: string | null): void {
  write(LAST_RIDE_KEY, code ? JSON.stringify({ code, at: Date.now() }) : null);
}
