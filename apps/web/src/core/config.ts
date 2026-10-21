import { Capacitor } from '@capacitor/core';

export const IS_NATIVE = Capacitor.isNativePlatform();

/** Where the Socket.io + /api server lives. Same origin on the web; native builds must set VITE_SERVER_URL. */
export const SERVER_URL: string = import.meta.env.VITE_SERVER_URL || window.location.origin;

/** MapLibre style URLs. Night falls back to the map feature's built-in dark treatment when unset. */
export const MAP_STYLE_DAY: string =
  import.meta.env.VITE_MAP_STYLE_DAY || 'https://tiles.openfreemap.org/styles/liberty';
export const MAP_STYLE_NIGHT: string | null = import.meta.env.VITE_MAP_STYLE_NIGHT || null;

function readFlag(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Exposes window.__intercom test hooks. On in dev, or with ?debug=1, or localStorage intercom:debug=1. */
export const DEBUG_ENABLED: boolean =
  import.meta.env.DEV ||
  new URLSearchParams(window.location.search).has('debug') ||
  readFlag('intercom:debug') === '1';

/** ?demo=1 seeds a fake ride so the UI can be developed and screenshotted without a server. */
export const DEMO_MODE: boolean = new URLSearchParams(window.location.search).has('demo');
