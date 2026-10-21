/**
 * Socket.io protocol between rider clients and the ride server.
 *
 * Delivery rules (the server must follow these; clients may rely on them):
 * - Every state-changing broadcast goes to the WHOLE ride room, including the rider who caused it.
 *   Clients upsert by id, so receiving your own event is harmless. Clients suppress alert side
 *   effects (siren, chime, toast) for alerts they raised themselves.
 * - Exception: `loc:relay` is sent to everyone EXCEPT the sender (high volume, pointless echo).
 * - Exception: `rtc:signal` goes only to the addressed rider.
 * - Every client->server event except `loc:update` and `rtc:signal` takes an ack callback and always
 *   gets exactly one `Result`. Invalid payloads get `{ ok: false, error: 'invalid_payload' }`.
 * - Events from a socket that has not joined a ride get `not_in_ride` (or are dropped if no ack).
 * - `sos:raise` and `break:request` carry client-generated ids and are idempotent: retrying with the
 *   same id returns the existing alert.
 * - Reconnecting clients simply send `ride:join` again with the same rider id + secret and receive a
 *   fresh snapshot (no event replay). The snapshot includes active SOS alerts and recent breaks.
 */
import type { z } from 'zod';
import type {
  breakKindSchema,
  breakRequestSchema,
  leaderTransferSchema,
  locationFixSchema,
  micModeSchema,
  placeSchema,
  placeSearchSchema,
  rideCreateSchema,
  rideJoinSchema,
  riderAuthSchema,
  riderUpdateSchema,
  routeSetSchema,
  rtcSignalDataSchema,
  rtcSignalSchema,
  sosIdSchema,
  sosRaiseSchema,
  timeSyncSchema,
  voiceModeSchema,
  voiceSetModeSchema,
} from './schemas';

// ---- domain types -----------------------------------------------------------------------

export type RiderId = string;
export type RideCode = string;
export type LocationFix = z.infer<typeof locationFixSchema>;
export type MicMode = z.infer<typeof micModeSchema>;
export type VoiceMode = z.infer<typeof voiceModeSchema>;
export type BreakKind = z.infer<typeof breakKindSchema>;
export type Place = z.infer<typeof placeSchema>;
export type RiderAuth = z.infer<typeof riderAuthSchema>;
export type RiderRole = 'leader' | 'rider';

export interface RiderState {
  id: RiderId;
  name: string;
  color: string;
  role: RiderRole;
  /** True while the rider has a connected socket. */
  online: boolean;
  /** Server time (ms) the rider first joined this ride. */
  joinedAt: number;
  /** Server time (ms) of the rider's last message of any kind. */
  lastSeenAt: number;
  location: LocationFix | null;
  /** Server time (ms) `location` was received. */
  locationAt: number | null;
  micMode: MicMode;
}

export type RouteProvider = 'valhalla' | 'osrm' | 'ors' | 'mock' | 'straight';

export interface RideRoute {
  id: string;
  destination: Place;
  waypoints: Place[];
  /** Simplified route line, [lng, lat] pairs, at most LIMITS.maxRoutePoints points. */
  geometry: [number, number][];
  distanceM: number;
  durationS: number;
  provider: RouteProvider;
  /** 'straight' means routing failed and the line is a straight segment to the destination. */
  profile: 'motorcycle' | 'car' | 'straight';
  setBy: RiderId;
  /** Server time (ms). */
  setAt: number;
}

export interface SosResponder {
  riderId: RiderId;
  at: number;
}

export interface SosAlert {
  id: string;
  riderId: RiderId;
  location: LocationFix | null;
  /** Server time (ms); client time only for alerts that arrived peer-to-peer. */
  raisedAt: number;
  /** Riders who tapped "I'm coming". */
  responders: SosResponder[];
}

export interface BreakAlert {
  id: string;
  riderId: RiderId;
  kind: BreakKind;
  location: LocationFix | null;
  at: number;
}

export interface RideSnapshot {
  code: RideCode;
  createdAt: number;
  leaderId: RiderId;
  voiceMode: VoiceMode;
  maxRiders: number;
  riders: RiderState[];
  route: RideRoute | null;
  activeSos: SosAlert[];
  /** Newest first. */
  recentBreaks: BreakAlert[];
  /** Server clock at snapshot time, for client clock-offset estimation. */
  serverNow: number;
}

/** Same shape as the browser's RTCIceServer. */
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface LiveKitJoinInfo {
  /** wss:// URL of the LiveKit server. */
  url: string;
  /** Access token; identity = rider id, may publish microphone audio and data. */
  token: string;
  /** LiveKit room name for this ride. */
  room: string;
}

export interface VoiceJoinInfo {
  /** Transport every rider in this ride must use right now. */
  mode: VoiceMode;
  /** Transports the server can offer (livekit only when configured). */
  available: VoiceMode[];
  /** Present when mode === 'livekit'. */
  livekit: LiveKitJoinInfo | null;
  /** STUN/TURN servers for mesh mode. */
  iceServers: IceServer[];
}

export interface JoinResult {
  snapshot: RideSnapshot;
  selfId: RiderId;
  voice: VoiceJoinInfo;
  /** True when this rider id was already in the ride (reconnect / reload). */
  resumed: boolean;
}

// ---- payloads (input types: what a client sends) ------------------------------------------

export type RideCreatePayload = z.input<typeof rideCreateSchema>;
export type RideJoinPayload = z.input<typeof rideJoinSchema>;
export type RiderUpdatePayload = z.input<typeof riderUpdateSchema>;
export type SosRaisePayload = z.input<typeof sosRaiseSchema>;
export type SosIdPayload = z.input<typeof sosIdSchema>;
export type BreakRequestPayload = z.input<typeof breakRequestSchema>;
export type RouteSetPayload = z.input<typeof routeSetSchema>;
export type PlaceSearchPayload = z.input<typeof placeSearchSchema>;
export type LeaderTransferPayload = z.input<typeof leaderTransferSchema>;
export type VoiceSetModePayload = z.input<typeof voiceSetModeSchema>;
export type RtcSignalData = z.input<typeof rtcSignalDataSchema>;
export type RtcSignalPayload = z.input<typeof rtcSignalSchema>;
export type TimeSyncPayload = z.input<typeof timeSyncSchema>;
export type Empty = Record<never, never>;

// ---- results -------------------------------------------------------------------------------

export type ErrorCode =
  | 'invalid_payload'
  | 'ride_not_found'
  | 'ride_full'
  /** The rider id is already in the ride and the secret does not match. */
  | 'rider_conflict'
  | 'not_in_ride'
  | 'not_leader'
  | 'rate_limited'
  /** Break requested again inside the cooldown; see retryInMs. */
  | 'cooldown'
  | 'not_found'
  /** Requested feature is not configured on this server (e.g. LiveKit). */
  | 'unavailable'
  /** route:set without an origin and the leader has no location yet. */
  | 'no_origin'
  | 'route_failed'
  | 'geocode_failed'
  | 'internal';

export type Ok<T extends object = Empty> = { ok: true } & T;
export interface Err {
  ok: false;
  error: ErrorCode;
  message?: string;
  retryInMs?: number;
}
export type Result<T extends object = Empty> = Ok<T> | Err;
export type Ack<T extends object = Empty> = (result: Result<T>) => void;

// ---- event maps ----------------------------------------------------------------------------

export interface ClientToServerEvents {
  /** Create a ride; the creator joins as leader. */
  'ride:create': (p: RideCreatePayload, ack: Ack<JoinResult>) => void;
  /** Join (or rejoin after a disconnect) a ride. */
  'ride:join': (p: RideJoinPayload, ack: Ack<JoinResult>) => void;
  /** Leave for good. Disconnecting without this keeps the rider's slot (shown offline). */
  'ride:leave': (p: Empty, ack: Ack) => void;
  'rider:update': (p: RiderUpdatePayload, ack: Ack<{ rider: RiderState }>) => void;
  /** No ack. Server rate-limits to LIMITS.locPerSecond and drops fixes older than the last one. */
  'loc:update': (fix: LocationFix) => void;
  'sos:raise': (p: SosRaisePayload, ack: Ack<{ sos: SosAlert }>) => void;
  /** Only the rider who raised it (or the leader) may cancel. */
  'sos:cancel': (p: SosIdPayload, ack: Ack) => void;
  /** "I'm coming". */
  'sos:respond': (p: SosIdPayload, ack: Ack<{ sos: SosAlert }>) => void;
  /** One per TIMING.breakCooldownMs per rider; otherwise `cooldown` with retryInMs. */
  'break:request': (p: BreakRequestPayload, ack: Ack<{ alert: BreakAlert }>) => void;
  /** Leader only. The server computes the route and broadcasts `route:updated`. */
  'route:set': (p: RouteSetPayload, ack: Ack<{ route: RideRoute }>) => void;
  /** Leader only. */
  'route:clear': (p: Empty, ack: Ack) => void;
  'place:search': (p: PlaceSearchPayload, ack: Ack<{ results: Place[] }>) => void;
  /** Leader only. */
  'leader:transfer': (p: LeaderTransferPayload, ack: Ack) => void;
  /** Leader only. Switches every rider to the given transport via `voice:mode`. */
  'voice:setMode': (p: VoiceSetModePayload, ack: Ack) => void;
  /** Fresh LiveKit token for this rider (e.g. after expiry). `unavailable` if LiveKit is off. */
  'voice:token': (p: Empty, ack: Ack<{ livekit: LiveKitJoinInfo }>) => void;
  /** Mesh WebRTC signaling, relayed only to `to` if it is online in the same ride. No ack. */
  'rtc:signal': (p: RtcSignalPayload) => void;
  'time:sync': (p: TimeSyncPayload, ack: (r: { t0: number; serverNow: number }) => void) => void;
}

export interface ServerToClientEvents {
  'rider:joined': (rider: RiderState) => void;
  /** Any change to a rider: presence (online/offline), profile, mic mode, role. */
  'rider:updated': (rider: RiderState) => void;
  /** Rider left for good (or was pruned). */
  'rider:left': (p: { riderId: RiderId }) => void;
  /** Sent to everyone except the sender. `rt` = server receive time. */
  'loc:relay': (p: { riderId: RiderId; fix: LocationFix; rt: number }) => void;
  'sos:raised': (sos: SosAlert) => void;
  /** Responders changed. */
  'sos:updated': (sos: SosAlert) => void;
  'sos:cancelled': (p: { id: string; riderId: RiderId; by: RiderId; at: number }) => void;
  'break:requested': (alert: BreakAlert) => void;
  'route:updated': (p: { route: RideRoute | null; by: RiderId }) => void;
  'leader:changed': (p: { leaderId: RiderId; by: RiderId | null }) => void;
  /** Sent per socket (tokens are per rider) when the leader switches transport. */
  'voice:mode': (p: { voice: VoiceJoinInfo; by: RiderId }) => void;
  'rtc:signal': (p: { from: RiderId; data: RtcSignalData }) => void;
  /** This rider id joined from another tab/device; this socket is being disconnected. */
  'session:replaced': () => void;
}

/**
 * Messages mirrored over the voice transport's data channel (LiveKit data / mesh RTCDataChannel)
 * so an SOS still spreads when the Socket.io server is unreachable. Receivers dedupe by id.
 */
export type VoiceDataMessage =
  | { type: 'sos'; sos: SosAlert }
  | { type: 'sos-cancel'; id: string; riderId: RiderId };
