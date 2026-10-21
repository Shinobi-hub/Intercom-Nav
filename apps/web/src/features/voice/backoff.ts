/** Exponential backoff with jitter for reconnect loops. */
export class Backoff {
  private attempt = 0;

  constructor(
    private readonly baseMs = 1_000,
    private readonly maxMs = 30_000,
    private readonly jitter = 0.25,
    private readonly random: () => number = Math.random,
  ) {}

  /** Consecutive failures so far. */
  get attempts(): number {
    return this.attempt;
  }

  /** Delay before the next try: base * 2^n, capped, +-jitter. */
  next(): number {
    const raw = Math.min(this.maxMs, this.baseMs * 2 ** this.attempt);
    this.attempt++;
    return Math.round(raw * (1 - this.jitter + 2 * this.jitter * this.random()));
  }

  reset(): void {
    this.attempt = 0;
  }
}
