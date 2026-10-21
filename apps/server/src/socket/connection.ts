import { LIMITS } from '@intercom/shared';
import { resolveClientIp } from '../net/clientIp';
import { perMinute, perSecond, TokenBucket, type BucketSpec } from '../util/rateLimit';
import type { ServerContext } from './context';
import { registerAlertHandlers } from './handlers/alerts';
import { registerMembershipHandlers } from './handlers/membership';
import { registerNavigationHandlers } from './handlers/navigation';
import { registerRealtimeHandlers } from './handlers/realtime';
import { registerVoiceHandlers } from './handlers/voice';
import type { IoSocket } from './io';
import { createEventRouter } from './router';

/** Catch-all for acked events without a limit of their own (profile updates, cancels, ...). */
const GENERAL_LIMIT: BucketSpec = { capacity: 40, refillPerSec: 20 };

/** Wires one client connection: its rate limits (all per socket) and every event handler. */
export function handleConnection(ctx: ServerContext, socket: IoSocket, trustProxyHops: number): void {
  socket.data.ip = resolveClientIp(socket.handshake.address, socket.handshake.headers['x-forwarded-for'], trustProxyHops);
  const bucket = (spec: BucketSpec) => new TokenBucket(spec, ctx.now);
  const router = createEventRouter(ctx, socket, bucket(GENERAL_LIMIT));

  registerMembershipHandlers(ctx, socket, router);
  registerAlertHandlers(ctx, router, { sos: bucket(perMinute(LIMITS.sosPerMinute)) });
  registerNavigationHandlers(ctx, router, {
    route: bucket(perMinute(LIMITS.routeSetPerMinute)),
    search: bucket(perMinute(LIMITS.placeSearchPerMinute)),
  });
  registerRealtimeHandlers(ctx, socket, router, {
    loc: bucket(perSecond(LIMITS.locPerSecond)),
    rtc: bucket(perSecond(LIMITS.rtcSignalPerSecond)),
  });
  registerVoiceHandlers(ctx, router);
  ctx.log.debug({ sid: socket.id }, 'socket connected');
}
