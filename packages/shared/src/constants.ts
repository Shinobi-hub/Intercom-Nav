/** Ride codes skip look-alike characters (0/O, 1/I/L) so they can be read aloud at a meetup. */
export const RIDE_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const RIDE_CODE_LENGTH = 6;

export const RIDER_NAME_MAX = 24;
export const RIDER_SECRET_MIN = 16;
export const RIDER_SECRET_MAX = 128;

/**
 * Rider marker colors. Red and amber are reserved for SOS and break alerts,
 * so the palette avoids them. All stay legible on light and dark map styles.
 */
export const RIDER_COLORS = [
  '#0A84FF', // blue
  '#30D158', // green
  '#BF5AF2', // purple
  '#64D2FF', // cyan
  '#5E5CE6', // indigo
  '#00C7BE', // teal
  '#FF6FD8', // pink
  '#A3E635', // lime
] as const;

export const TIMING = {
  /** Never send location more often than this. */
  locMinIntervalMs: 500,
  /** Send at least this often, even when stopped. */
  locHeartbeatMs: 5_000,
  /**
   * Heartbeats re-send the newest fix only while it is younger than this. A rider whose GPS goes
   * quiet stays live for others until then, and turns stale riderStaleMs after the last heartbeat.
   */
  locHeartbeatMaxFixAgeMs: 30_000,
  /** Movement that triggers a send before the heartbeat. */
  locMinMoveM: 5,
  /** Heading change that triggers a send (only when moving). */
  locMinHeadingChangeDeg: 20,
  /** A rider with no location update (fix or heartbeat) for this long is drawn faded. */
  riderStaleMs: 15_000,
  /** ...and after this long shows "last seen". */
  riderLostMs: 60_000,
  /** Dead reckoning stops after this long without a fix. */
  deadReckonMaxMs: 3_000,
  breakCooldownMs: 30_000,
  sosHoldMs: 1_500,
  sosRetryMs: 3_000,
  /** Leadership moves to another rider if the leader is offline this long. */
  leaderGraceMs: 5 * 60_000,
  /** Offline riders are dropped from a full ride after this long. */
  riderPruneMs: 30 * 60_000,
  /** A ride with nobody online is deleted after this long. */
  rideIdleTtlMs: 60 * 60_000,
  /** Break alerts older than this are dropped from ride state. */
  recentBreakMs: 30 * 60_000,
  /** Music ducking envelope. */
  duckAttackMs: 80,
  duckHoldMs: 700,
  duckReleaseMs: 800,
} as const;

export const LIMITS = {
  maxRidersDefault: 8,
  maxRidersCap: 16,
  locPerSecond: 4,
  sosPerMinute: 10,
  maxActiveSosPerRider: 3,
  routeSetPerMinute: 6,
  placeSearchPerMinute: 30,
  rtcSignalPerSecond: 50,
  joinPerMinutePerIp: 20,
  maxWaypoints: 8,
  maxRoutePoints: 2_000,
  recentBreaksKept: 20,
  sdpMaxChars: 20_000,
  placeQueryMin: 2,
  placeQueryMax: 120,
  placeResultsMax: 8,
} as const;

export const AUDIO_DEFAULTS = {
  /** Music gain while anyone is talking (0.3 = ducked by 70%). */
  duckLevel: 0.3,
  /** VAD sensitivity, 0 (needs loud speech) .. 1 (triggers easily). */
  vadSensitivity: 0.5,
  voiceVolume: 1,
  musicVolume: 0.8,
} as const;

export const PROTOCOL_VERSION = 1;
export const SOCKET_PATH = '/socket.io';
