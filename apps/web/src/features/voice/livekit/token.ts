/** Reads the expiry of a LiveKit access token (a JWT) without verifying it. */
export function tokenExpiresAt(token: string): number | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='))) as { exp?: unknown };
    return typeof json.exp === 'number' ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** True when the token is expired or will be within `marginMs` (unknown expiry counts as fine). */
export function tokenNeedsRefresh(token: string, now = Date.now(), marginMs = 60_000): boolean {
  const exp = tokenExpiresAt(token);
  return exp !== null && exp - now < marginMs;
}
