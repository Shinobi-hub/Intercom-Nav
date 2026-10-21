import { normalizeOrigin } from '../config';

export interface OriginPolicyOptions {
  /** Normalized extra origins (CORS_ORIGINS). */
  allowedOrigins: readonly string[];
  /** Development convenience: any http://localhost:* or http://127.0.0.1:* page. */
  allowLocalhost: boolean;
}

export interface OriginPolicy {
  /** May a page on `origin` call us cross-origin? */
  allowsCrossOrigin(origin: string): boolean;
  /**
   * Full check for a request: no Origin header (native or server-side clients), a page served by
   * this very host, or an allowed cross origin.
   */
  allowsRequest(origin: string | undefined, host: string | undefined): boolean;
}

export function createOriginPolicy(opts: OriginPolicyOptions): OriginPolicy {
  const allowed = new Set(opts.allowedOrigins);

  const allowsCrossOrigin = (origin: string): boolean => {
    const normalized = normalizeOrigin(origin);
    if (!normalized) return false;
    if (allowed.has(normalized)) return true;
    if (!opts.allowLocalhost) return false;
    const { protocol, hostname } = new URL(normalized);
    return protocol === 'http:' && (hostname === 'localhost' || hostname === '127.0.0.1');
  };

  return {
    allowsCrossOrigin,
    allowsRequest(origin, host) {
      if (origin === undefined) return true;
      const normalized = normalizeOrigin(origin);
      if (normalized && host && new URL(normalized).host === host.trim().toLowerCase()) return true;
      return allowsCrossOrigin(origin);
    },
  };
}
