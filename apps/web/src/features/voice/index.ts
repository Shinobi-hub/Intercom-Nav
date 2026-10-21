// Public surface of the voice feature: the voice manager factory (LiveKit SFU or P2P mesh).
import type { AudioEngineApi, VoiceManagerApi } from '../../core/services';
import type { AppSocket } from '../../core/socket';
import type { SignalingChannel } from './mesh/signaling';
import { VoiceManager } from './voiceManager';

export interface VoiceManagerDeps {
  socket: AppSocket;
  audio: AudioEngineApi;
  /** Mesh signaling override (dev harness: BroadcastChannel between tabs). Defaults to the socket. */
  signaling?: SignalingChannel;
}

export function createVoiceManager(deps: VoiceManagerDeps): VoiceManagerApi {
  return new VoiceManager(deps);
}

export { broadcastSignaling, socketSignaling, type SignalingChannel } from './mesh/signaling';
