export type AckFn = (result: unknown) => void;

/**
 * Splits Socket.io handler arguments into payload and ack. The ack, when present, is always the
 * last argument; clients may also omit the payload, omit the ack, or pass garbage in either place.
 * The returned ack fires at most once and never throws into the caller.
 */
export function splitArgs(args: readonly unknown[]): { payload: unknown; ack: AckFn | null } {
  const last = args[args.length - 1];
  if (typeof last !== 'function') return { payload: args[0], ack: null };
  let done = false;
  const ack: AckFn = (result) => {
    if (done) return;
    done = true;
    try {
      (last as AckFn)(result);
    } catch {
      /* the socket went away mid-reply */
    }
  };
  return { payload: args.length > 1 ? args[0] : undefined, ack };
}
