import type { AudioSessionApi } from '../../core/services';

/** W3C Audio Session API (Safari 16.4+). Not in TypeScript's DOM lib yet. */
type AudioSessionType = 'auto' | 'playback' | 'transient' | 'transient-solo' | 'ambient' | 'play-and-record';
interface NavigatorAudioSession {
  audioSession?: { type: AudioSessionType };
}

export function createWebAudioSession(nav: Navigator = navigator): AudioSessionApi {
  return {
    setMode(mode) {
      const session = (nav as Navigator & NavigatorAudioSession).audioSession;
      if (!session || session.type === mode) return;
      try {
        session.type = mode;
      } catch (err) {
        console.warn('[platform] audioSession.type rejected', mode, err);
      }
    },
  };
}
