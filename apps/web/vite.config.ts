import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

/** The ride server (Socket.io + /api). Vite proxies to it so the app stays same-origin in dev. */
const SERVER = process.env.INTERCOM_SERVER_URL ?? 'http://127.0.0.1:8787';
const proxy = {
  '/api': SERVER,
  '/socket.io': { target: SERVER, ws: true },
};

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // Updates wait until every tab is closed: swapping the service worker mid-ride could break
      // lazily fetched assets (e.g. the audio worklet) while voice is live.
      registerType: 'prompt',
      injectRegister: 'auto',
      includeAssets: ['icon.svg', 'icon-maskable.svg', 'apple-touch-icon.png'],
      manifest: {
        id: '/',
        name: 'Intercom Nav',
        short_name: 'Intercom',
        description: 'Group ride intercom: live rider map, shared route, voice, music that ducks under speech, SOS and break alerts.',
        lang: 'en',
        dir: 'ltr',
        theme_color: '#0B0D10',
        background_color: '#0B0D10',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        scope: '/',
        categories: ['navigation', 'travel', 'social'],
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      workbox: {
        // First install takes control at once; later updates still wait (registerType 'prompt').
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        navigateFallback: '/index.html',
        // The ride server's API and Socket.io never go through the service worker.
        navigateFallbackDenylist: [/^\/api\//, /^\/socket\.io\//],
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,wasm}'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        runtimeCaching: [
          {
            // Style and TileJSON documents point at the current tile build: refresh in the background.
            urlPattern: ({ url }) =>
              url.origin === 'https://tiles.openfreemap.org' &&
              (url.pathname.startsWith('/styles/') || /^\/planet\/?$/.test(url.pathname)),
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'map-styles',
              expiration: { maxEntries: 20, maxAgeSeconds: 30 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Vector tiles, glyphs and sprites are immutable per URL: cache-first so the map still
            // draws where a ride has been, even in a dead zone.
            urlPattern: ({ url }) => url.origin === 'https://tiles.openfreemap.org',
            handler: 'CacheFirst',
            options: {
              cacheName: 'map-tiles',
              expiration: { maxEntries: 3000, maxAgeSeconds: 30 * 24 * 60 * 60, purgeOnQuotaError: true },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: { host: true, port: 5173, proxy },
  preview: { host: true, port: 4173, proxy },
  build: { target: 'es2022', sourcemap: true },
  worker: { format: 'es' },
});
