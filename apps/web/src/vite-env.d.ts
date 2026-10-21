/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  /** Ride server origin. Unset on the web (same origin); required for native builds. */
  readonly VITE_SERVER_URL?: string;
  readonly VITE_MAP_STYLE_DAY?: string;
  readonly VITE_MAP_STYLE_NIGHT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
