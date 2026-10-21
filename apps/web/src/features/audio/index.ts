// Public surface of the audio feature: the engine factory and the two components the UI renders.
import type { AudioEngineApi, PlatformApi } from '../../core/services';
import { AudioEngine } from './engine/audioEngine';

export interface AudioEngineDeps {
  platform: PlatformApi;
}

export function createAudioEngine(deps: AudioEngineDeps): AudioEngineApi {
  return new AudioEngine(deps);
}

export { MusicPanel } from './components/MusicPanel';
export { MicLevelMeter } from './components/MicLevelMeter';
export type { AnnounceOptions } from './alerts/announcer';
