/**
 * Condition-based waiting. Nothing here sleeps and then asserts: waits poll until a condition holds
 * (or time runs out), and "nothing happens" checks poll for the whole window and fail on the first
 * sample that breaks the rule.
 */

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface WaitOptions {
  timeout: number;
  /** Poll interval, ms. Default 100. */
  interval?: number;
  /** What we were waiting for, used as the failure message. */
  message: string;
}

/** Polls `fn` until it returns a truthy value and returns it. Errors are retried until the deadline. */
export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, opts: WaitOptions): Promise<T> {
  const deadline = Date.now() + opts.timeout;
  let lastError: unknown = null;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
      lastError = null;
    } catch (e) {
      lastError = e;
    }
    if (Date.now() >= deadline) {
      const why = lastError ? `\n  last error: ${lastError instanceof Error ? lastError.message : String(lastError)}` : '';
      throw new Error(`${opts.message} (not within ${opts.timeout} ms)${why}`);
    }
    await sleep(opts.interval ?? 100);
  }
}

export interface StableOptions {
  /** How long the condition must keep holding, ms. */
  during: number;
  interval?: number;
  message: string;
}

/**
 * Asserts `check(value)` holds for every sample over `during` ms. `check` returns null when fine, or a
 * description of what's wrong. Fails immediately on the first violation.
 */
export async function expectStable<T>(fn: () => Promise<T>, check: (value: T) => string | null, opts: StableOptions): Promise<void> {
  const end = Date.now() + opts.during;
  let samples = 0;
  for (;;) {
    const value = await fn();
    samples++;
    const problem = check(value);
    if (problem) throw new Error(`${opts.message}: ${problem} (after ${samples} samples)`);
    if (Date.now() >= end) return;
    await sleep(opts.interval ?? 200);
  }
}
