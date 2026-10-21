import type { PlatformApi } from '../../core/services';
import { createWebAudioSession } from './audioSession';
import { createWebBackground } from './background';
import { createWebGeo } from './geo';
import { createWebHaptics } from './haptics';
import { createWebLifecycle } from './lifecycle';
import { createWebNetwork } from './network';
import { openExternalWeb, shareWeb } from './share';
import { createWebWakeLock } from './wakeLock';

/** Browser (PWA) implementation of the platform layer. */
export function createWebPlatform(): PlatformApi {
  return {
    kind: 'web',
    isNative: false,
    geo: createWebGeo(),
    wakeLock: createWebWakeLock(),
    lifecycle: createWebLifecycle(),
    haptics: createWebHaptics(),
    audioSession: createWebAudioSession(),
    background: createWebBackground(),
    network: createWebNetwork(),
    openExternal: (url) => openExternalWeb(url),
    share: (data) => shareWeb(data),
  };
}
