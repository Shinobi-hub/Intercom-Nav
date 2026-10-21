import {
  generateRideCode,
  LIMITS,
  type BreakAlert,
  type BreakKind,
  type Err,
  type LatLng,
  type LocationFix,
  type MicMode,
  type RideCode,
  type RideRoute,
  type RiderAuth,
  type RiderId,
  type RideSnapshot,
  type RiderState,
  type SosAlert,
  type VoiceMode,
} from '@intercom/shared';
import type { Clock } from '../util/clock';
import { fail } from '../util/result';
import { hashSecret, secretMatches } from './secret';
import { toRiderState, toSnapshot, toSosAlert } from './snapshot';
import type { ActiveSos, Ride, Rider } from './types';

export interface RideTiming {
  leaderGraceMs: number;
  riderPruneMs: number;
  rideIdleTtlMs: number;
  breakCooldownMs: number;
  recentBreakMs: number;
}

export interface RideStoreOptions {
  now: Clock;
  maxRiders: number;
  timing: RideTiming;
  generateCode?: () => RideCode;
}

export type Outcome<T extends object = Record<never, never>> = ({ ok: true } & T) | Err;

export interface Member {
  ride: Ride;
  rider: Rider;
}

export interface LeaderChange {
  leaderId: RiderId;
  previousId: RiderId;
}

export interface JoinOk extends Member {
  resumed: boolean;
  /** Session that spoke for this rider until now and must be told it was replaced. */
  replacedSessionId: string | null;
  /** Long-offline riders removed to make room. */
  pruned: RiderId[];
  leaderChange: LeaderChange | null;
}

export interface LeaveOk {
  rider: Rider;
  rideDeleted: boolean;
  /** The leaving rider's own SOS alerts, cancelled on their way out. */
  cancelledSos: SosAlert[];
  leaderChange: LeaderChange | null;
}

export interface SweepResult {
  deletedRides: RideCode[];
  leaderChanges: (LeaderChange & { code: RideCode })[];
}

export interface ProfilePatch {
  name?: string;
  color?: string;
  micMode?: MicMode;
}

/** Cancelled SOS ids remembered per ride. */
const ENDED_SOS_KEPT = 200;
/**
 * A fix that is not newer than the stored one is normally dropped as out of order. Once the stored
 * fix is this stale, though, the rider's clock most likely jumped backwards; accept it so their
 * marker doesn't freeze until the clock catches up.
 */
const LOCATION_CLOCK_RESET_MS = 30_000;
const CODE_ATTEMPTS = 50;

/**
 * All ride and rider state, with no knowledge of sockets: callers pass an opaque `sessionId` and
 * turn the returned outcomes into acks and broadcasts. Time comes from the injected clock.
 */
export class RideStore {
  private readonly rides = new Map<RideCode, Ride>();
  private readonly now: Clock;
  private readonly generateCode: () => RideCode;

  constructor(private readonly opts: RideStoreOptions) {
    this.now = opts.now;
    this.generateCode = opts.generateCode ?? generateRideCode;
  }

  get rideCount(): number {
    return this.rides.size;
  }

  get riderCount(): number {
    let n = 0;
    for (const ride of this.rides.values()) n += ride.riders.size;
    return n;
  }

  get(code: RideCode): Ride | undefined {
    return this.rides.get(code);
  }

  member(code: RideCode, riderId: RiderId): Member | null {
    const ride = this.rides.get(code);
    const rider = ride?.riders.get(riderId);
    return ride && rider ? { ride, rider } : null;
  }

  snapshot(ride: Ride): RideSnapshot {
    return toSnapshot(ride, this.now(), this.opts.timing.recentBreakMs);
  }

  riderState(ride: Ride, rider: Rider): RiderState {
    return toRiderState(ride, rider);
  }

  // ---- membership ----------------------------------------------------------------------------

  create(auth: RiderAuth, voiceMode: VoiceMode, sessionId: string): Member {
    const code = this.uniqueCode();
    const now = this.now();
    const rider = newRider(auth, sessionId, now);
    const ride: Ride = {
      code,
      createdAt: now,
      maxRiders: this.opts.maxRiders,
      leaderId: rider.id,
      voiceMode,
      voiceEpoch: 0,
      riders: new Map([[rider.id, rider]]),
      route: null,
      routeSeq: 0,
      routeAppliedSeq: 0,
      sos: new Map(),
      endedSos: new Set(),
      breaks: [],
    };
    this.rides.set(code, ride);
    return { ride, rider };
  }

  join(code: RideCode, auth: RiderAuth, sessionId: string): Outcome<JoinOk> {
    const ride = this.rides.get(code);
    if (!ride) return fail('ride_not_found', 'No ride with that code');
    const now = this.now();

    const existing = ride.riders.get(auth.id);
    if (existing) {
      if (!secretMatches(existing.secretHash, auth.secret)) {
        return fail('rider_conflict', 'This rider id is already in the ride');
      }
      const replacedSessionId =
        existing.sessionId !== null && existing.sessionId !== sessionId ? existing.sessionId : null;
      existing.name = auth.name;
      existing.color = auth.color;
      existing.online = true;
      existing.sessionId = sessionId;
      existing.lastSeenAt = now;
      return { ok: true, ride, rider: existing, resumed: true, replacedSessionId, pruned: [], leaderChange: null };
    }

    const pruned: RiderId[] = [];
    if (ride.riders.size >= ride.maxRiders) {
      const stale = [...ride.riders.values()].filter((r) => this.isPrunable(ride, r, now));
      if (ride.riders.size - stale.length >= ride.maxRiders) return fail('ride_full', 'This ride is full');
      for (const r of stale) {
        ride.riders.delete(r.id);
        pruned.push(r.id);
      }
    }

    const rider = newRider(auth, sessionId, now);
    ride.riders.set(rider.id, rider);
    const leaderChange = ride.riders.has(ride.leaderId) ? null : this.reassignLeader(ride);
    return { ok: true, ride, rider, resumed: false, replacedSessionId: null, pruned, leaderChange };
  }

  leave(code: RideCode, riderId: RiderId): Outcome<LeaveOk> {
    const m = this.member(code, riderId);
    if (!m) return fail('not_in_ride');
    const { ride, rider } = m;
    ride.riders.delete(riderId);

    const cancelledSos: SosAlert[] = [];
    for (const sos of [...ride.sos.values()]) {
      if (sos.riderId !== riderId) continue;
      cancelledSos.push(toSosAlert(sos));
      this.endSos(ride, sos.id);
    }

    if (ride.riders.size === 0) {
      this.rides.delete(code);
      return { ok: true, rider, rideDeleted: true, cancelledSos, leaderChange: null };
    }
    const leaderChange = ride.leaderId === riderId ? this.reassignLeader(ride) : null;
    return { ok: true, rider, rideDeleted: false, cancelledSos, leaderChange };
  }

  /** Marks the rider offline, but only if `sessionId` still speaks for them. */
  disconnect(code: RideCode, riderId: RiderId, sessionId: string): Member | null {
    const m = this.member(code, riderId);
    if (!m || m.rider.sessionId !== sessionId) return null;
    m.rider.online = false;
    m.rider.sessionId = null;
    m.rider.lastSeenAt = this.now();
    return m;
  }

  /** Records activity (any message) from a rider. */
  touch(code: RideCode, riderId: RiderId): void {
    const m = this.member(code, riderId);
    if (m) m.rider.lastSeenAt = this.now();
  }

  updateProfile(code: RideCode, riderId: RiderId, patch: ProfilePatch): Outcome<Member & { changed: boolean }> {
    const m = this.member(code, riderId);
    if (!m) return fail('not_in_ride');
    const { rider } = m;
    let changed = false;
    if (patch.name !== undefined && patch.name !== rider.name) {
      rider.name = patch.name;
      changed = true;
    }
    if (patch.color !== undefined && patch.color !== rider.color) {
      rider.color = patch.color;
      changed = true;
    }
    if (patch.micMode !== undefined && patch.micMode !== rider.micMode) {
      rider.micMode = patch.micMode;
      changed = true;
    }
    return { ok: true, ...m, changed };
  }

  /** Stores a fix unless it is older than the one we have. Returns the member when accepted. */
  updateLocation(code: RideCode, riderId: RiderId, fix: LocationFix): Member | null {
    const m = this.member(code, riderId);
    if (!m) return null;
    const { rider } = m;
    const now = this.now();
    const prev = rider.location;
    if (prev && fix.t <= prev.t) {
      const storedAge = rider.locationAt === null ? Infinity : now - rider.locationAt;
      if (storedAge < LOCATION_CLOCK_RESET_MS) return null;
    }
    rider.location = fix;
    rider.locationAt = now;
    rider.lastSeenAt = now;
    return m;
  }

  // ---- alerts ----------------------------------------------------------------------------------

  raiseSos(
    code: RideCode,
    riderId: RiderId,
    input: { id: string; location: LocationFix | null },
  ): Outcome<{ sos: SosAlert; created: boolean }> {
    const m = this.member(code, riderId);
    if (!m) return fail('not_in_ride');
    const { ride, rider } = m;
    const existing = ride.sos.get(input.id);
    if (existing) return { ok: true, sos: toSosAlert(existing), created: false };
    if (ride.endedSos.has(input.id)) return fail('not_found', 'This SOS was already cancelled');

    let active = 0;
    for (const s of ride.sos.values()) if (s.riderId === riderId) active++;
    if (active >= LIMITS.maxActiveSosPerRider) {
      return fail('rate_limited', `At most ${LIMITS.maxActiveSosPerRider} active SOS alerts per rider`);
    }
    const sos: ActiveSos = {
      id: input.id,
      riderId,
      location: input.location ?? rider.location,
      raisedAt: this.now(),
      responders: [],
    };
    ride.sos.set(sos.id, sos);
    return { ok: true, sos: toSosAlert(sos), created: true };
  }

  cancelSos(code: RideCode, riderId: RiderId, id: string): Outcome<{ sos: SosAlert; at: number }> {
    const m = this.member(code, riderId);
    if (!m) return fail('not_in_ride');
    const { ride } = m;
    const sos = ride.sos.get(id);
    if (!sos) return fail('not_found', 'No active SOS with that id');
    if (sos.riderId !== riderId && ride.leaderId !== riderId) {
      return fail('not_leader', 'Only the rider who raised the SOS or the leader can cancel it');
    }
    this.endSos(ride, id);
    return { ok: true, sos: toSosAlert(sos), at: this.now() };
  }

  respondSos(code: RideCode, riderId: RiderId, id: string): Outcome<{ sos: SosAlert; changed: boolean }> {
    const m = this.member(code, riderId);
    if (!m) return fail('not_in_ride');
    const sos = m.ride.sos.get(id);
    if (!sos) return fail('not_found', 'No active SOS with that id');
    if (sos.riderId === riderId || sos.responders.some((r) => r.riderId === riderId)) {
      return { ok: true, sos: toSosAlert(sos), changed: false };
    }
    sos.responders.push({ riderId, at: this.now() });
    return { ok: true, sos: toSosAlert(sos), changed: true };
  }

  requestBreak(
    code: RideCode,
    riderId: RiderId,
    input: { id: string; kind: BreakKind; location: LocationFix | null },
  ): Outcome<{ alert: BreakAlert; created: boolean }> {
    const m = this.member(code, riderId);
    if (!m) return fail('not_in_ride');
    const { ride, rider } = m;
    const now = this.now();
    this.expireBreaks(ride, now);

    const existing = ride.breaks.find((b) => b.id === input.id);
    if (existing) return { ok: true, alert: { ...existing }, created: false };
    if (rider.lastBreakAt !== null) {
      const waitMs = rider.lastBreakAt + this.opts.timing.breakCooldownMs - now;
      if (waitMs > 0) return fail('cooldown', 'You asked for a break moments ago', waitMs);
    }
    const alert: BreakAlert = {
      id: input.id,
      riderId,
      kind: input.kind,
      location: input.location ?? rider.location,
      at: now,
    };
    ride.breaks.unshift(alert);
    if (ride.breaks.length > LIMITS.recentBreaksKept) ride.breaks.length = LIMITS.recentBreaksKept;
    rider.lastBreakAt = now;
    return { ok: true, alert: { ...alert }, created: true };
  }

  // ---- route -----------------------------------------------------------------------------------

  /** Authorizes a route request and resolves its origin; the route itself is computed elsewhere. */
  startRoute(
    code: RideCode,
    riderId: RiderId,
    origin: LatLng | undefined,
  ): Outcome<{ ride: Ride; seq: number; origin: LatLng }> {
    const m = this.member(code, riderId);
    if (!m) return fail('not_in_ride');
    const { ride, rider } = m;
    if (ride.leaderId !== riderId) return fail('not_leader', 'Only the leader can set the route');
    const from = origin ?? (rider.location ? { lat: rider.location.lat, lng: rider.location.lng } : null);
    if (!from) return fail('no_origin', 'Your location is not known yet');
    ride.routeSeq += 1;
    return { ok: true, ride, seq: ride.routeSeq, origin: from };
  }

  /**
   * Stores a route computed for request `seq` of `ride`, unless the ride is gone (or its code now
   * belongs to a new ride), the requester left, or a newer request or a clear superseded it.
   */
  commitRoute(ride: Ride, riderId: RiderId, seq: number, route: RideRoute): Outcome {
    if (this.rides.get(ride.code) !== ride || !ride.riders.has(riderId)) return fail('not_in_ride');
    if (seq <= ride.routeAppliedSeq) return fail('route_failed', 'A newer route request replaced this one');
    ride.route = route;
    ride.routeAppliedSeq = seq;
    return { ok: true };
  }

  clearRoute(code: RideCode, riderId: RiderId): Outcome<{ changed: boolean }> {
    const m = this.member(code, riderId);
    if (!m) return fail('not_in_ride');
    const { ride } = m;
    if (ride.leaderId !== riderId) return fail('not_leader', 'Only the leader can clear the route');
    // Also invalidates any route still being computed.
    ride.routeSeq += 1;
    ride.routeAppliedSeq = ride.routeSeq;
    const changed = ride.route !== null;
    ride.route = null;
    return { ok: true, changed };
  }

  // ---- leadership and voice ------------------------------------------------------------------

  transferLeader(code: RideCode, riderId: RiderId, to: RiderId): Outcome<{ change: LeaderChange | null }> {
    const m = this.member(code, riderId);
    if (!m) return fail('not_in_ride');
    const { ride } = m;
    if (ride.leaderId !== riderId) return fail('not_leader', 'Only the leader can hand over leadership');
    if (to === riderId) return { ok: true, change: null };
    const target = ride.riders.get(to);
    if (!target) return fail('not_found', 'That rider is not in this ride');
    if (!target.online) return fail('not_found', 'That rider is offline');
    ride.leaderId = to;
    return { ok: true, change: { leaderId: to, previousId: riderId } };
  }

  setVoiceMode(
    code: RideCode,
    riderId: RiderId,
    mode: VoiceMode,
    available: readonly VoiceMode[],
  ): Outcome<{ changed: boolean; epoch: number }> {
    const m = this.member(code, riderId);
    if (!m) return fail('not_in_ride');
    const { ride } = m;
    if (ride.leaderId !== riderId) return fail('not_leader', 'Only the leader can switch the voice transport');
    if (!available.includes(mode)) return fail('unavailable', `${mode} voice is not configured on this server`);
    if (ride.voiceMode === mode) return { ok: true, changed: false, epoch: ride.voiceEpoch };
    ride.voiceMode = mode;
    ride.voiceEpoch += 1;
    return { ok: true, changed: true, epoch: ride.voiceEpoch };
  }

  // ---- housekeeping --------------------------------------------------------------------------

  /** Deletes idle rides, moves leadership away from long-offline leaders, expires old breaks. */
  sweep(): SweepResult {
    const now = this.now();
    const { rideIdleTtlMs, leaderGraceMs } = this.opts.timing;
    const result: SweepResult = { deletedRides: [], leaderChanges: [] };

    for (const ride of [...this.rides.values()]) {
      this.expireBreaks(ride, now);

      let anyOnline = false;
      let lastSeenAt = 0;
      for (const r of ride.riders.values()) {
        if (r.online) anyOnline = true;
        lastSeenAt = Math.max(lastSeenAt, r.lastSeenAt);
      }
      if (!anyOnline && now - lastSeenAt >= rideIdleTtlMs) {
        this.rides.delete(ride.code);
        result.deletedRides.push(ride.code);
        continue;
      }

      const leader = ride.riders.get(ride.leaderId);
      if (leader && (leader.online || now - leader.lastSeenAt <= leaderGraceMs)) continue;
      const next = firstOnline(ride);
      if (next) {
        const previousId = ride.leaderId;
        ride.leaderId = next.id;
        result.leaderChanges.push({ code: ride.code, leaderId: next.id, previousId });
      }
    }
    return result;
  }

  // ---- internals -------------------------------------------------------------------------------

  private uniqueCode(): RideCode {
    for (let i = 0; i < CODE_ATTEMPTS; i++) {
      const code = this.generateCode();
      if (!this.rides.has(code)) return code;
    }
    throw new Error('Could not allocate a unique ride code');
  }

  /** Riders with an active SOS are never pruned: going quiet is exactly when it matters. */
  private isPrunable(ride: Ride, rider: Rider, now: number): boolean {
    if (rider.online || now - rider.lastSeenAt <= this.opts.timing.riderPruneMs) return false;
    for (const s of ride.sos.values()) if (s.riderId === rider.id) return false;
    return true;
  }

  /** Earliest-joined online rider, else whoever joined first. */
  private reassignLeader(ride: Ride): LeaderChange | null {
    const next = firstOnline(ride) ?? ride.riders.values().next().value;
    if (!next) return null;
    const previousId = ride.leaderId;
    ride.leaderId = next.id;
    return { leaderId: next.id, previousId };
  }

  private endSos(ride: Ride, id: string): void {
    ride.sos.delete(id);
    ride.endedSos.add(id);
    if (ride.endedSos.size > ENDED_SOS_KEPT) {
      const oldest = ride.endedSos.values().next().value;
      if (oldest !== undefined) ride.endedSos.delete(oldest);
    }
  }

  private expireBreaks(ride: Ride, now: number): void {
    const keepMs = this.opts.timing.recentBreakMs;
    if (ride.breaks.some((b) => now - b.at >= keepMs)) {
      ride.breaks = ride.breaks.filter((b) => now - b.at < keepMs);
    }
  }
}

function firstOnline(ride: Ride): Rider | undefined {
  for (const r of ride.riders.values()) if (r.online) return r;
  return undefined;
}

function newRider(auth: RiderAuth, sessionId: string, now: number): Rider {
  return {
    id: auth.id,
    secretHash: hashSecret(auth.secret),
    name: auth.name,
    color: auth.color,
    micMode: 'vox',
    joinedAt: now,
    lastSeenAt: now,
    online: true,
    sessionId,
    location: null,
    locationAt: null,
    lastBreakAt: null,
  };
}
