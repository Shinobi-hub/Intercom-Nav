import { AccessToken, TrackSource } from 'livekit-server-sdk';

export const LIVEKIT_TOKEN_TTL_S = 6 * 60 * 60;

export interface LiveKitCredentials {
  apiKey: string;
  apiSecret: string;
}

export const liveKitRoomName = (rideCode: string) => `ride-${rideCode}`;

/** Join token for one rider: microphone audio and data only, subscribe to everything. */
export function mintLiveKitToken(
  creds: LiveKitCredentials,
  grant: { room: string; identity: string; name: string },
): Promise<string> {
  const token = new AccessToken(creds.apiKey, creds.apiSecret, {
    identity: grant.identity,
    name: grant.name,
    ttl: LIVEKIT_TOKEN_TTL_S,
  });
  token.addGrant({
    roomJoin: true,
    room: grant.room,
    canPublish: true,
    canPublishSources: [TrackSource.MICROPHONE],
    canPublishData: true,
    canSubscribe: true,
  });
  return token.toJwt();
}
