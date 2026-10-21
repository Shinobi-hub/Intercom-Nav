import {
  leaderTransferSchema,
  rideCreateSchema,
  rideJoinSchema,
  riderUpdateSchema,
  timeSyncSchema,
  type Err,
  type JoinResult,
  type LiveKitJoinInfo,
  type Ok,
  type RideCode,
  type RiderId,
} from '@intercom/shared';
import type { Ride, Rider } from '../../rides/types';
import { fail } from '../../util/result';
import {
  announceLeaderChange,
  bindSocket,
  currentBinding,
  leaveRide,
  rideRoom,
  socketBySession,
  unbindSocket,
  type ServerContext,
} from '../context';
import type { IoSocket } from '../io';
import { emptyPayload, type EventRouter } from '../router';

/** ride:create, ride:join, ride:leave, rider:update, leader:transfer, time:sync and disconnects. */
export function registerMembershipHandlers(ctx: ServerContext, socket: IoSocket, router: EventRouter): void {
  const { store, voice, io, log } = ctx;

  const joinRateLimited = (): Err | null =>
    ctx.joinLimiter.take(socket.data.ip)
      ? null
      : fail('rate_limited', 'Too many join attempts, try again shortly', ctx.joinLimiter.retryInMs(socket.data.ip));

  const joinResult = (ride: Ride, rider: Rider, liveKit: LiveKitJoinInfo | null, resumed: boolean): Ok<JoinResult> => ({
    ok: true,
    snapshot: store.snapshot(ride),
    selfId: rider.id,
    voice: voice.joinInfo(ride.voiceMode, rider.id, liveKit),
    resumed,
  });

  /** One ride per socket: speaking for someone else now means leaving the previous ride. */
  const leavePrevious = (code: RideCode, riderId: RiderId) => {
    const prev = currentBinding(ctx, socket);
    if (prev && (prev.code !== code || prev.riderId !== riderId)) leaveRide(ctx, socket, prev);
  };

  const replaceSession = (sessionId: string) => {
    const old = socketBySession(ctx, sessionId);
    if (!old || old.id === socket.id) return;
    unbindSocket(old);
    old.emit('session:replaced');
    old.disconnect(true);
  };

  router.open('ride:create', rideCreateSchema, async (input) => {
    const limited = joinRateLimited();
    if (limited) return limited;
    const { ride, rider } = store.create(input.rider, voice.resolveMode(input.voiceMode), socket.id);
    leavePrevious(ride.code, rider.id);
    bindSocket(socket, ride.code, rider.id);
    log.info({ code: ride.code, riderId: rider.id, voiceMode: ride.voiceMode }, 'ride created');
    // Nobody else knows the code yet, so the ride can't change while the token is minted.
    const liveKit = await voice.liveKit(ride.code, rider.id, rider.name);
    if (store.member(ride.code, rider.id)?.ride !== ride) return fail('not_in_ride', 'Left the ride before it was ready');
    return joinResult(ride, rider, liveKit, false);
  });

  router.open('ride:join', rideJoinSchema, async ({ code, rider: auth }, call) => {
    const limited = joinRateLimited();
    if (limited) return limited;
    // Minted first so the join below, its snapshot and the ack happen in one synchronous step.
    const liveKit = await voice.liveKit(code, auth.id, auth.name);
    const res = store.join(code, auth, socket.id);
    if (!res.ok) return res;
    const { ride, rider, resumed } = res;

    leavePrevious(code, rider.id);
    if (res.replacedSessionId) replaceSession(res.replacedSessionId);
    const room = io.to(rideRoom(code));
    for (const riderId of res.pruned) room.emit('rider:left', { riderId });
    if (res.leaderChange) announceLeaderChange(ctx, ride, res.leaderChange, null);
    bindSocket(socket, code, rider.id);
    log.info({ code, riderId: rider.id, resumed, pruned: res.pruned.length }, resumed ? 'rider resumed' : 'rider joined');

    const state = store.riderState(ride, rider);
    call.afterAck(() => {
      if (resumed) room.emit('rider:updated', state);
      else room.emit('rider:joined', state);
    });
    return joinResult(ride, rider, liveKit, resumed);
  });

  router.ride('ride:leave', emptyPayload, (_input, binding) => {
    const res = leaveRide(ctx, socket, binding);
    return res.ok ? { ok: true } : res;
  });

  router.ride('rider:update', riderUpdateSchema, (patch, { code, riderId }, call) => {
    const res = store.updateProfile(code, riderId, patch);
    if (!res.ok) return res;
    const rider = store.riderState(res.ride, res.rider);
    if (res.changed) call.afterAck(() => io.to(rideRoom(code)).emit('rider:updated', rider));
    return { ok: true, rider };
  });

  router.ride('leader:transfer', leaderTransferSchema, ({ to }, { code, riderId }, call) => {
    const res = store.transferLeader(code, riderId, to);
    if (!res.ok) return res;
    const ride = store.get(code);
    const change = res.change;
    if (change && ride) {
      log.info({ code, from: riderId, to }, 'leadership handed over');
      call.afterAck(() => announceLeaderChange(ctx, ride, change, riderId));
    }
    return { ok: true };
  });

  // Works before joining too; the reply is { t0, serverNow } rather than a Result.
  router.raw('time:sync', (payload, ack) => {
    if (!ack) return;
    const parsed = timeSyncSchema.safeParse(payload);
    ack(parsed.success ? { t0: parsed.data.t0, serverNow: ctx.now() } : fail('invalid_payload'));
  });

  socket.on('disconnect', (reason) => {
    const { code, riderId } = socket.data;
    if (!code || !riderId) return;
    try {
      // Only if this socket still speaks for the rider: a replaced session must not flip them offline.
      const m = store.disconnect(code, riderId, socket.id);
      if (!m) return;
      io.to(rideRoom(code)).emit('rider:updated', store.riderState(m.ride, m.rider));
      log.info({ code, riderId, reason }, 'rider offline');
    } catch (err) {
      log.error({ err }, 'disconnect handling failed');
    }
  });
}
