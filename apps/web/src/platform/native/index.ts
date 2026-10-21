/**
 * Capacitor (Android/iOS) implementation of the platform layer. Loaded with a dynamic import from
 * ../index.ts, so none of the plugin code ends up in the web bundle's main chunk.
 */
import { KeepAwake } from '@capacitor-community/keep-awake';
import { App } from '@capacitor/app';
import { Haptics } from '@capacitor/haptics';
import { LocalNotifications } from '@capacitor/local-notifications';
import type { PlatformApi } from '../../core/services';
import { isSafeExternalUrl } from '../common/urls';
import { createWebNetwork } from '../web/network';
import { openExternalWeb, shareWeb } from '../web/share';
import { createNativeAudioSession } from './audioSession';
import { createNativeBackground } from './background';
import { createNativeGeo } from './geo';
import { createNativeHaptics } from './haptics';
import { createNativeLifecycle } from './lifecycle';
import { createNativeNotifier } from './notifications';
import { createPermissionBroker } from './permissions';
import { BackgroundGeolocation, RideService } from './plugins';
import { createNativeWakeLock } from './wakeLock';

export function createNativePlatform(kind: 'android' | 'ios'): PlatformApi {
  const permissions = createPermissionBroker(RideService);
  const notifier = createNativeNotifier(LocalNotifications, kind);

  return {
    kind,
    isNative: true,
    geo: createNativeGeo({
      plugin: BackgroundGeolocation,
      kind,
      ensurePermission:
        kind === 'android' ? async () => (await permissions.ensure(['location'])).location === 'granted' : undefined,
    }),
    wakeLock: createNativeWakeLock(KeepAwake),
    lifecycle: createNativeLifecycle(App, kind),
    haptics: createNativeHaptics({ plugin: Haptics, kind }),
    audioSession: createNativeAudioSession(kind, RideService),
    background: createNativeBackground({ kind, rideService: RideService, permissions, notifier }),
    // WebView online/offline events are accurate on both platforms (Android needs
    // ACCESS_NETWORK_STATE, declared in the manifest).
    network: createWebNetwork(),
    openExternal(url) {
      if (!isSafeExternalUrl(url)) {
        console.warn('[platform] refusing to open', url);
        return;
      }
      RideService.openUrl({ url }).catch(() => openExternalWeb(url));
    },
    async share(data) {
      try {
        return (await RideService.share(data)).completed;
      } catch {
        return shareWeb(data);
      }
    },
  };
}
