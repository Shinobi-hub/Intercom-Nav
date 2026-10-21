import { voiceSetModeSchema, type RideCode, type RiderId } from '@intercom/shared';
import { fail } from '../../util/result';
import { socketBySession, type ServerContext } from '../context';
import { emptyPayload, type EventRouter } from '../router';

/** voice:setMode, voice:token. */
export function registerVoiceHandlers(ctx: ServerContext, router: EventRouter): void {
  const { store, log } = ctx;

  router.ride('voice:setMode', voiceSetModeSchema, ({ mode }, { code, riderId }, call) => {
    const res = store.setVoiceMode(code, riderId, mode, ctx.voice.available);
    if (!res.ok) return res;
    if (res.changed) {
      log.info({ code, mode, by: riderId }, 'voice transport switched');
      call.afterAck(() => {
        announceVoiceMode(ctx, code, res.epoch, riderId).catch((err: unknown) =>
          log.error({ err, code }, 'voice:mode announcement failed'),
        );
      });
    }
    return { ok: true };
  });

  router.ride('voice:token', emptyPayload, async (_input, { code, riderId }) => {
    if (!ctx.voice.liveKitEnabled) return fail('unavailable', 'LiveKit voice is not configured on this server');
    const m = store.member(code, riderId);
    if (!m) return fail('not_in_ride');
    const livekit = await ctx.voice.liveKit(code, riderId, m.rider.name);
    return livekit ? { ok: true, livekit } : fail('unavailable');
  });
}

/**
 * Sends `voice:mode` to each online rider's socket separately, since LiveKit tokens are per rider.
 * Dropped if another switch happened while tokens were minted; riders who reconnected meanwhile
 * already got the new mode in their join result.
 */
export async function announceVoiceMode(ctx: ServerContext, code: RideCode, epoch: number, by: RiderId): Promise<void> {
  const ride = ctx.store.get(code);
  if (!ride) return;
  const mode = ride.voiceMode;
  const targets = [...ride.riders.values()]
    .filter((r) => r.online && r.sessionId !== null)
    .map((r) => ({ riderId: r.id, name: r.name, sessionId: r.sessionId }));
  const liveKit = await Promise.all(
    targets.map((t) => (mode === 'livekit' ? ctx.voice.liveKit(code, t.riderId, t.name) : null)),
  );
  if (ctx.store.get(code) !== ride || ride.voiceEpoch !== epoch) return;
  targets.forEach((t, i) => {
    if (ride.riders.get(t.riderId)?.sessionId !== t.sessionId) return;
    const voice = ctx.voice.joinInfo(mode, t.riderId, liveKit[i] ?? null);
    socketBySession(ctx, t.sessionId)?.emit('voice:mode', { voice, by });
  });
}
