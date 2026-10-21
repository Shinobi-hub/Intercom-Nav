import { emptySchema, type ClientToServerEvents, type Result } from '@intercom/shared';
import { z } from 'zod';
import { fail } from '../util/result';
import type { TokenBucket } from '../util/rateLimit';
import { splitArgs, type AckFn } from './args';
import { currentBinding, type Binding, type ServerContext } from './context';
import type { IoSocket } from './io';

export type FireEvent = 'loc:update' | 'rtc:signal';
export type AckEvent = Exclude<keyof ClientToServerEvents, FireEvent | 'time:sync'>;
type Reply = Result<object> | Promise<Result<object>>;

/** For events whose payload is `{}`; a missing payload counts as empty. */
export const emptyPayload = z.preprocess((v) => (v === undefined || v === null ? {} : v), emptySchema);

export interface CallScope {
  /** Runs after the ack is sent, so the caller sees its result before the resulting broadcast. */
  afterAck(fn: () => void): void;
}

export interface EventRouter {
  /** Ack'd event that needs no ride (create / join). */
  open<S extends z.ZodType>(event: AckEvent, schema: S, run: (input: z.output<S>, call: CallScope) => Reply): void;
  /** Ack'd event from a rider in a ride; others get `not_in_ride`. */
  ride<S extends z.ZodType>(
    event: AckEvent,
    schema: S,
    run: (input: z.output<S>, binding: Binding, call: CallScope) => Reply,
    limiter?: TokenBucket | null,
  ): void;
  /** Fire-and-forget event from a rider in a ride; anything invalid or over the limit is dropped. */
  fire<S extends z.ZodType>(event: FireEvent, schema: S, limiter: TokenBucket, run: (input: z.output<S>, binding: Binding) => void): void;
  /** Raw listener with the same activity tracking and error containment. */
  raw(event: keyof ClientToServerEvents, run: (payload: unknown, ack: AckFn | null) => void): void;
}

/**
 * Every client message goes through here: split args, record activity, rate-limit, validate,
 * check membership, run, ack exactly once. Nothing a client sends can throw out of a listener.
 */
export function createEventRouter(ctx: ServerContext, socket: IoSocket, generalLimiter: TokenBucket): EventRouter {
  const listen = (event: string, fn: (...args: unknown[]) => void) =>
    (socket as unknown as { on(ev: string, listener: (...args: unknown[]) => void): void }).on(event, fn);

  const raw: EventRouter['raw'] = (event, run) => {
    listen(event, (...args) => {
      const { payload, ack } = splitArgs(args);
      try {
        const binding = currentBinding(ctx, socket);
        if (binding) ctx.store.touch(binding.code, binding.riderId);
        run(payload, ack);
      } catch (err) {
        ctx.log.error({ err, event }, 'socket handler failed');
        ack?.(fail('internal'));
      }
    });
  };

  const respond = (event: string, ack: AckFn | null, work: (call: CallScope) => Reply) => {
    const after: (() => void)[] = [];
    const call: CallScope = { afterAck: (fn) => after.push(fn) };
    const finish = (result: Result<object>) => {
      ack?.(result);
      for (const fn of after) {
        try {
          fn();
        } catch (err) {
          ctx.log.error({ err, event }, 'post-ack step failed');
        }
      }
    };
    const onError = (err: unknown) => {
      ctx.log.error({ err, event }, 'socket handler failed');
      after.length = 0;
      finish(fail('internal'));
    };
    try {
      const result = work(call);
      if (result instanceof Promise) result.then(finish, onError);
      else finish(result);
    } catch (err) {
      onError(err);
    }
  };

  return {
    raw,

    open(event, schema, run) {
      raw(event, (payload, ack) => {
        const parsed = schema.safeParse(payload);
        if (!parsed.success) return ack?.(fail('invalid_payload'));
        respond(event, ack, (call) => run(parsed.data, call));
      });
    },

    ride(event, schema, run, limiter = generalLimiter) {
      raw(event, (payload, ack) => {
        if (limiter && !limiter.take()) return ack?.(fail('rate_limited', 'Slow down', limiter.retryInMs()));
        const parsed = schema.safeParse(payload);
        if (!parsed.success) return ack?.(fail('invalid_payload'));
        const binding = currentBinding(ctx, socket);
        if (!binding) return ack?.(fail('not_in_ride'));
        respond(event, ack, (call) => run(parsed.data, binding, call));
      });
    },

    fire(event, schema, limiter, run) {
      raw(event, (payload) => {
        if (!limiter.take()) return;
        const parsed = schema.safeParse(payload);
        if (!parsed.success) return;
        const binding = currentBinding(ctx, socket);
        if (binding) run(parsed.data, binding);
      });
    },
  };
}
