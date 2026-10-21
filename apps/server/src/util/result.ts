import type { Err, ErrorCode } from '@intercom/shared';

export function fail(error: ErrorCode, message?: string, retryInMs?: number): Err {
  const err: Err = { ok: false, error };
  if (message) err.message = message;
  if (retryInMs !== undefined) err.retryInMs = retryInMs;
  return err;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
