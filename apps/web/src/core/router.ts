/** Two routes, so a 30-line router instead of a dependency: "/" and "/r/:code". */
import { isValidRideCode, normalizeRideCode } from '@intercom/shared';
import { useMemo, useSyncExternalStore } from 'react';

export type Route = { name: 'home' } | { name: 'ride'; code: string };

export function parseRoute(pathname: string): Route {
  const m = /^\/r\/([A-Za-z0-9-]{1,32})\/?$/.exec(pathname);
  if (m) {
    const code = normalizeRideCode(m[1]!);
    if (isValidRideCode(code)) return { name: 'ride', code };
  }
  return { name: 'home' };
}

export const ridePath = (code: string) => `/r/${code}`;

const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  window.addEventListener('popstate', cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener('popstate', cb);
  };
}

export function navigate(path: string, opts: { replace?: boolean } = {}): void {
  if (path === window.location.pathname) return;
  if (opts.replace) window.history.replaceState(null, '', path);
  else window.history.pushState(null, '', path);
  for (const l of listeners) l();
}

export function useRoute(): Route {
  const path = useSyncExternalStore(subscribe, () => window.location.pathname);
  return useMemo(() => parseRoute(path), [path]);
}
