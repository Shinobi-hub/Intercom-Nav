/** What the voice manager needs from a transport (LiveKit SFU or peer-to-peer mesh). */
import type { RiderId, VoiceDataMessage, VoiceJoinInfo, VoiceMode } from '@intercom/shared';
import type { VoiceStats } from '../../core/services';
import type { PeerState, VoiceState } from '../../core/store';

export interface TransportCallbacks {
  onState(state: VoiceState, error?: string | null): void;
  /** null: the rider is gone from this transport. */
  onPeerState(riderId: RiderId, state: PeerState | null): void;
  /** A remote rider's audio track appeared, changed, or (null) went away. */
  onRemoteTrack(riderId: RiderId, track: MediaStreamTrack | null): void;
  onData(from: RiderId, msg: VoiceDataMessage): void;
}

export interface VoiceTransport {
  readonly mode: VoiceMode;
  /** Connects. Rejects if the first attempt fails, but keeps retrying in the background. */
  start(): Promise<void>;
  /** Same mode, fresh credentials or ICE servers. Must be cheap when nothing relevant changed. */
  update(info: VoiceJoinInfo): Promise<void>;
  /** Publish, replace or (null) unpublish the outgoing mic track. */
  setOutgoingTrack(track: MediaStreamTrack | null): Promise<void>;
  sendData(msg: VoiceDataMessage): void;
  getStats(): Promise<VoiceStats>;
  stop(): Promise<void>;
}
