import { createHmac } from 'node:crypto';
import type { IceServer } from '@intercom/shared';

export const TURN_CREDENTIAL_TTL_S = 12 * 60 * 60;

export interface IceConfig {
  stunUrls: readonly string[];
  turnUrls: readonly string[];
  turnUsername: string | null;
  turnCredential: string | null;
  turnSecret: string | null;
}

/**
 * coturn `use-auth-secret` (TURN REST API) credentials: the username carries its own expiry and
 * the password is HMAC-SHA1(secret, username), so coturn can verify it without a user database.
 */
export function coturnCredentials(
  secret: string,
  riderId: string,
  nowMs: number,
  ttlS = TURN_CREDENTIAL_TTL_S,
): { username: string; credential: string } {
  const expiresAt = Math.floor(nowMs / 1000) + ttlS;
  const username = `${expiresAt}:${riderId}`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential };
}

/**
 * STUN/TURN servers for one rider's mesh connections. A TURN entry is only emitted with
 * credentials: browsers reject `turn:` URLs without them and the whole RTCPeerConnection fails.
 */
export function buildIceServers(cfg: IceConfig, riderId: string, nowMs: number): IceServer[] {
  const servers: IceServer[] = [];
  if (cfg.stunUrls.length > 0) servers.push({ urls: [...cfg.stunUrls] });
  if (cfg.turnUrls.length > 0) {
    if (cfg.turnUsername && cfg.turnCredential) {
      servers.push({ urls: [...cfg.turnUrls], username: cfg.turnUsername, credential: cfg.turnCredential });
    } else if (cfg.turnSecret) {
      servers.push({ urls: [...cfg.turnUrls], ...coturnCredentials(cfg.turnSecret, riderId, nowMs) });
    }
  }
  return servers;
}
