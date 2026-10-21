import type { AudioSessionApi } from '../../core/services';
import { createWebAudioSession } from '../web/audioSession';
import type { RideServicePlugin } from './plugins';

/**
 * iOS: configures AVAudioSession through RideService (play-and-record with Bluetooth HFP/A2DP,
 * speaker default and mixing while the mic is live; playback otherwise) and also sets WebKit's own
 * navigator.audioSession where WKWebView exposes it, so WebKit picks a matching category.
 * Android: no-op; Chromium switches MODE_IN_COMMUNICATION itself when capture starts.
 */
export function createNativeAudioSession(
  kind: 'android' | 'ios',
  rideService: Pick<RideServicePlugin, 'setAudioMode'>,
): AudioSessionApi {
  const web = createWebAudioSession();
  return {
    setMode(mode) {
      if (kind !== 'ios') return;
      web.setMode(mode);
      rideService.setAudioMode({ mode }).catch((err: unknown) => console.warn('[platform] setAudioMode failed', err));
    },
  };
}
