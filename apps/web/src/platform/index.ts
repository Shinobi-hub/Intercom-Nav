// Public surface of the platform layer: createPlatform() picks the web (PWA) or native (Capacitor)
// implementation of PlatformApi. See docs/NATIVE.md for the native side.
import { Capacitor } from '@capacitor/core';
import { DEBUG_ENABLED } from '../core/config';
import type { PlatformApi } from '../core/services';
import { createDeferredPlatform } from './deferred';
import { createPlatformProbe } from './probe';
import { createWebPlatform } from './web';

export function createPlatform(): PlatformApi {
  const kind = Capacitor.getPlatform();
  const platform =
    Capacitor.isNativePlatform() && (kind === 'android' || kind === 'ios')
      ? createDeferredPlatform(
          kind,
          // Dynamic import keeps the Capacitor plugin code out of the web main chunk.
          () => import('./native').then((m) => m.createNativePlatform(kind)),
          createWebPlatform,
        )
      : createWebPlatform();
  if (DEBUG_ENABLED) window.__intercomPlatform = createPlatformProbe(platform);
  return platform;
}
