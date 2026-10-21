import type { Clock } from './clock';

export interface BucketSpec {
  /** Burst size. */
  capacity: number;
  /** Tokens added per second. */
  refillPerSec: number;
}

export const perSecond = (n: number): BucketSpec => ({ capacity: n, refillPerSec: n });
export const perMinute = (n: number): BucketSpec => ({ capacity: n, refillPerSec: n / 60 });

/** Classic token bucket: starts full, refills continuously, one token per action. */
export class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  constructor(
    private readonly spec: BucketSpec,
    private readonly now: Clock,
  ) {
    this.tokens = spec.capacity;
    this.updatedAt = now();
  }

  /** Takes a token if one is available. */
  take(): boolean {
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** Milliseconds until the next token (0 when one is available now). */
  retryInMs(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil(((1 - this.tokens) / this.spec.refillPerSec) * 1000);
  }

  /** A full bucket behaves exactly like a fresh one, so it can be forgotten. */
  isFull(): boolean {
    this.refill();
    return this.tokens >= this.spec.capacity;
  }

  private refill(): void {
    const t = this.now();
    if (t > this.updatedAt) {
      this.tokens = Math.min(this.spec.capacity, this.tokens + ((t - this.updatedAt) / 1000) * this.spec.refillPerSec);
    }
    this.updatedAt = t;
  }
}

/** One bucket per key (e.g. client IP), with bounded memory. */
export class KeyedRateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(
    private readonly spec: BucketSpec,
    private readonly now: Clock,
    private readonly maxKeys = 10_000,
  ) {}

  take(key: string): boolean {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) this.evict();
      bucket = new TokenBucket(this.spec, this.now);
      this.buckets.set(key, bucket);
    }
    return bucket.take();
  }

  retryInMs(key: string): number {
    return this.buckets.get(key)?.retryInMs() ?? 0;
  }

  /** Forgets keys whose buckets have refilled. */
  prune(): void {
    for (const [key, bucket] of this.buckets) if (bucket.isFull()) this.buckets.delete(key);
  }

  get size(): number {
    return this.buckets.size;
  }

  private evict(): void {
    this.prune();
    // Still full of active keys (e.g. a flood from many addresses): drop the oldest.
    while (this.buckets.size >= this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
  }
}
