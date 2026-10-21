import type { RideSnapshot, RiderState, SosAlert } from '@intercom/shared';
import type { ActiveSos, Ride, Rider } from './types';

export function toRiderState(ride: Ride, rider: Rider): RiderState {
  return {
    id: rider.id,
    name: rider.name,
    color: rider.color,
    role: ride.leaderId === rider.id ? 'leader' : 'rider',
    online: rider.online,
    joinedAt: rider.joinedAt,
    lastSeenAt: rider.lastSeenAt,
    location: rider.location,
    locationAt: rider.locationAt,
    micMode: rider.micMode,
  };
}

export function toSosAlert(sos: ActiveSos): SosAlert {
  return {
    id: sos.id,
    riderId: sos.riderId,
    location: sos.location,
    raisedAt: sos.raisedAt,
    responders: sos.responders.map((r) => ({ ...r })),
  };
}

/** Everything a (re)joining client needs; breaks older than `recentBreakMs` are left out. */
export function toSnapshot(ride: Ride, now: number, recentBreakMs: number): RideSnapshot {
  return {
    code: ride.code,
    createdAt: ride.createdAt,
    leaderId: ride.leaderId,
    voiceMode: ride.voiceMode,
    maxRiders: ride.maxRiders,
    riders: [...ride.riders.values()].map((r) => toRiderState(ride, r)),
    route: ride.route,
    activeSos: [...ride.sos.values()].map(toSosAlert),
    recentBreaks: ride.breaks.filter((b) => now - b.at < recentBreakMs).map((b) => ({ ...b })),
    serverNow: now,
  };
}
