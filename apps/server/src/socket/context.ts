import type { RideCode, RiderId } from '@intercom/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { PlaceSearch } from '../geo/geocoding';
import type { RoutePlanner } from '../geo/routing';
import type { LeaderChange, LeaveOk, Outcome, RideStore } from '../rides/store';
import type { Ride } from '../rides/types';
import type { Clock } from '../util/clock';
import type { KeyedRateLimiter } from '../util/rateLimit';
import type { VoiceService } from '../voice/service';
import type { IoServer, IoSocket } from './io';

export interface ServerContext {
  io: IoServer;
  store: RideStore;
  voice: VoiceService;
  routes: RoutePlanner;
  places: PlaceSearch;
  now: Clock;
  log: FastifyBaseLogger;
  joinLimiter: KeyedRateLimiter;
}

/** The ride and rider a socket currently speaks for. */
export interface Binding {
  code: RideCode;
  riderId: RiderId;
}

export const rideRoom = (code: RideCode) => `ride:${code}`;

export function bindSocket(socket: IoSocket, code: RideCode, riderId: RiderId): void {
  socket.data.code = code;
  socket.data.riderId = riderId;
  void socket.join(rideRoom(code));
}

export function unbindSocket(socket: IoSocket): void {
  if (socket.data.code) void socket.leave(rideRoom(socket.data.code));
  delete socket.data.code;
  delete socket.data.riderId;
}

/**
 * The socket's binding, verified against the store: the rider must still exist and this socket
 * must still be their current session. A stale binding is dropped on the spot.
 */
export function currentBinding(ctx: ServerContext, socket: IoSocket): Binding | null {
  const { code, riderId } = socket.data;
  if (!code || !riderId) return null;
  const member = ctx.store.member(code, riderId);
  if (member?.rider.sessionId === socket.id) return { code, riderId };
  unbindSocket(socket);
  return null;
}

export function socketBySession(ctx: ServerContext, sessionId: string | null): IoSocket | undefined {
  return sessionId ? ctx.io.sockets.sockets.get(sessionId) : undefined;
}

export function emitRiderUpdated(ctx: ServerContext, ride: Ride, riderId: RiderId): void {
  const rider = ride.riders.get(riderId);
  if (rider) ctx.io.to(rideRoom(ride.code)).emit('rider:updated', ctx.store.riderState(ride, rider));
}

/** `leader:changed`, then `rider:updated` for both riders whose role changed. */
export function announceLeaderChange(ctx: ServerContext, ride: Ride, change: LeaderChange, by: RiderId | null): void {
  ctx.io.to(rideRoom(ride.code)).emit('leader:changed', { leaderId: change.leaderId, by });
  emitRiderUpdated(ctx, ride, change.previousId);
  emitRiderUpdated(ctx, ride, change.leaderId);
}

/**
 * Removes the socket's rider from its ride for good. The socket leaves the room first: it is no
 * longer part of the ride, and receiving its own `rider:left` would read as being kicked out.
 */
export function leaveRide(ctx: ServerContext, socket: IoSocket, binding: Binding): Outcome<LeaveOk> {
  unbindSocket(socket);
  const res = ctx.store.leave(binding.code, binding.riderId);
  if (!res.ok) return res;
  const room = ctx.io.to(rideRoom(binding.code));
  const at = ctx.now();
  for (const sos of res.cancelledSos) {
    room.emit('sos:cancelled', { id: sos.id, riderId: sos.riderId, by: binding.riderId, at });
  }
  room.emit('rider:left', { riderId: binding.riderId });
  const ride = ctx.store.get(binding.code);
  if (res.leaderChange && ride) announceLeaderChange(ctx, ride, res.leaderChange, null);
  ctx.log.info({ code: binding.code, riderId: binding.riderId, rideDeleted: res.rideDeleted }, 'rider left');
  return res;
}
