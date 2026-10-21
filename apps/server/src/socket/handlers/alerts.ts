import { breakRequestSchema, sosIdSchema, sosRaiseSchema } from '@intercom/shared';
import type { TokenBucket } from '../../util/rateLimit';
import { fail } from '../../util/result';
import { rideRoom, type ServerContext } from '../context';
import type { EventRouter } from '../router';

/** sos:raise, sos:cancel, sos:respond, break:request. */
export function registerAlertHandlers(ctx: ServerContext, router: EventRouter, limits: { sos: TokenBucket }): void {
  const { store, io, log } = ctx;

  router.ride(
    'sos:raise',
    sosRaiseSchema,
    (input, { code, riderId }, call) => {
      // Retries of an existing alert are free; only new alerts count against the limit.
      const isNew = !store.get(code)?.sos.has(input.id);
      if (isNew && !limits.sos.take()) return fail('rate_limited', 'Too many SOS alerts', limits.sos.retryInMs());
      const res = store.raiseSos(code, riderId, input);
      if (!res.ok) return res;
      if (res.created) {
        log.warn({ code, riderId, sosId: res.sos.id }, 'SOS raised');
        call.afterAck(() => io.to(rideRoom(code)).emit('sos:raised', res.sos));
      }
      return { ok: true, sos: res.sos };
    },
    null,
  );

  router.ride('sos:cancel', sosIdSchema, ({ id }, { code, riderId }, call) => {
    const res = store.cancelSos(code, riderId, id);
    if (!res.ok) return res;
    log.info({ code, sosId: id, by: riderId }, 'SOS cancelled');
    call.afterAck(() => io.to(rideRoom(code)).emit('sos:cancelled', { id, riderId: res.sos.riderId, by: riderId, at: res.at }));
    return { ok: true };
  });

  router.ride('sos:respond', sosIdSchema, ({ id }, { code, riderId }, call) => {
    const res = store.respondSos(code, riderId, id);
    if (!res.ok) return res;
    if (res.changed) call.afterAck(() => io.to(rideRoom(code)).emit('sos:updated', res.sos));
    return { ok: true, sos: res.sos };
  });

  router.ride('break:request', breakRequestSchema, (input, { code, riderId }, call) => {
    const res = store.requestBreak(code, riderId, input);
    if (!res.ok) return res;
    if (res.created) call.afterAck(() => io.to(rideRoom(code)).emit('break:requested', res.alert));
    return { ok: true, alert: res.alert };
  });
}
