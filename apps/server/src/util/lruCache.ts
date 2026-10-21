import type { Clock } from './clock';

export interface LruCacheOptions {
  maxEntries: number;
  ttlMs: number;
  now: Clock;
}

/** Size-bounded cache with per-entry expiry. Map iteration order doubles as recency order. */
export class LruCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(private readonly opts: LruCacheOptions) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (entry.expiresAt <= this.opts.now()) return undefined;
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.opts.now() + this.opts.ttlMs });
    while (this.entries.size > this.opts.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
