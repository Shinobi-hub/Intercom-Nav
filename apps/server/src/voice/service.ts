import type { LiveKitJoinInfo, RideCode, RiderId, VoiceJoinInfo, VoiceMode } from '@intercom/shared';
import type { Config } from '../config';
import type { Clock } from '../util/clock';
import { buildIceServers } from './ice';
import { liveKitRoomName, mintLiveKitToken } from './livekit';

export interface VoiceService {
  /** Transports this server can offer; livekit only when fully configured. */
  readonly available: readonly VoiceMode[];
  /** DEFAULT_VOICE_MODE if available, else mesh. */
  readonly defaultMode: VoiceMode;
  readonly liveKitEnabled: boolean;
  /** A ride's transport: the requested one if available, else the default. */
  resolveMode(requested: VoiceMode | undefined): VoiceMode;
  /** Fresh LiveKit credentials for a rider, or null when LiveKit is not configured. */
  liveKit(code: RideCode, riderId: RiderId, name: string): Promise<LiveKitJoinInfo | null>;
  /** Assembles the join info; `liveKit` is only attached in livekit mode. */
  joinInfo(mode: VoiceMode, riderId: RiderId, liveKit: LiveKitJoinInfo | null): VoiceJoinInfo;
}

export function createVoiceService(cfg: Config['voice'], now: Clock): VoiceService {
  const lk = cfg.livekit;
  const available: VoiceMode[] = lk ? ['livekit', 'mesh'] : ['mesh'];
  const defaultMode: VoiceMode = available.includes(cfg.defaultMode) ? cfg.defaultMode : 'mesh';

  return {
    available,
    defaultMode,
    liveKitEnabled: lk !== null,
    resolveMode: (requested) => (requested && available.includes(requested) ? requested : defaultMode),
    async liveKit(code, riderId, name) {
      if (!lk) return null;
      const room = liveKitRoomName(code);
      const token = await mintLiveKitToken(lk, { room, identity: riderId, name });
      return { url: lk.url, token, room };
    },
    joinInfo: (mode, riderId, liveKit) => ({
      mode,
      available: [...available],
      livekit: mode === 'livekit' ? liveKit : null,
      iceServers: buildIceServers(cfg, riderId, now()),
    }),
  };
}
