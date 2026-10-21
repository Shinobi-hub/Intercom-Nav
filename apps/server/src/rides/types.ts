import type {
  BreakAlert,
  LocationFix,
  MicMode,
  RideCode,
  RideRoute,
  RiderId,
  SosResponder,
  VoiceMode,
} from '@intercom/shared';

/** Server-side rider record. `RiderState` (protocol) is derived from it. */
export interface Rider {
  readonly id: RiderId;
  /** SHA-256 of the client's secret; the secret itself is never stored. */
  readonly secretHash: Buffer;
  name: string;
  color: string;
  micMode: MicMode;
  readonly joinedAt: number;
  lastSeenAt: number;
  online: boolean;
  /** Opaque id of the connection currently speaking for this rider (the socket id), if any. */
  sessionId: string | null;
  location: LocationFix | null;
  locationAt: number | null;
  lastBreakAt: number | null;
}

export interface ActiveSos {
  readonly id: string;
  readonly riderId: RiderId;
  readonly location: LocationFix | null;
  readonly raisedAt: number;
  readonly responders: SosResponder[];
}

export interface Ride {
  readonly code: RideCode;
  readonly createdAt: number;
  readonly maxRiders: number;
  leaderId: RiderId;
  voiceMode: VoiceMode;
  /** Bumped on every transport switch so slow, superseded announcements can be dropped. */
  voiceEpoch: number;
  /** Insertion order is join order (resuming keeps the slot). */
  readonly riders: Map<RiderId, Rider>;
  route: RideRoute | null;
  /** Last route request number handed out, and the one the current route (or clear) came from. */
  routeSeq: number;
  routeAppliedSeq: number;
  /** Active alerts in raise order. */
  readonly sos: Map<string, ActiveSos>;
  /** Recently cancelled SOS ids, so a late retry of `sos:raise` cannot resurrect them. */
  readonly endedSos: Set<string>;
  /** Newest first. */
  breaks: BreakAlert[];
}
