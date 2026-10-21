import { locationFixSchema, rtcSignalSchema } from '@intercom/shared';
import type { TokenBucket } from '../../util/rateLimit';
import { rideRoom, socketBySession, type ServerContext } from '../context';
import type { IoSocket } from '../io';
import type { EventRouter } from '../router';

/** loc:update and rtc:signal: high volume, no acks, silently dropped when invalid or over the limit. */
export function registerRealtimeHandlers(
  ctx: ServerContext,
  socket: IoSocket,
  router: EventRouter,
  limits: { loc: TokenBucket; rtc: TokenBucket },
): void {
  const { store } = ctx;

  router.fire('loc:update', locationFixSchema, limits.loc, (fix, { code, riderId }) => {
    const m = store.updateLocation(code, riderId, fix);
    if (!m) return;
    socket.to(rideRoom(code)).emit('loc:relay', { riderId, fix, rt: m.rider.locationAt ?? ctx.now() });
  });

  router.fire('rtc:signal', rtcSignalSchema, limits.rtc, ({ to, data }, { code, riderId }) => {
    if (to === riderId) return;
    const target = store.member(code, to);
    if (!target?.rider.online) return;
    socketBySession(ctx, target.rider.sessionId)?.emit('rtc:signal', { from: riderId, data });
  });
}
