import { describe, expect, it } from 'vitest';
import { LruCache } from './lruCache';
import { KeyedRateLimiter, perMinute, perSecond, TokenBucket } from './rateLimit';

function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms), set: (v: number) => void (t = v) };
}

describe('TokenBucket', () => {
  it('allows a burst of `capacity`, then refills continuously', () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(perSecond(4), clock.now);
    for (let i = 0; i < 4; i++) expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
    expect(bucket.retryInMs()).toBe(250);
    clock.advance(249);
    expect(bucket.take()).toBe(false);
    clock.advance(1);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
  });

  it('never refills above capacity', () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(perSecond(2), clock.now);
    clock.advance(60_000);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
  });

  it('supports per-minute rates', () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(perMinute(6), clock.now);
    for (let i = 0; i < 6; i++) expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
    expect(bucket.retryInMs()).toBe(10_000);
    clock.advance(10_000);
    expect(bucket.take()).toBe(true);
  });

  it('does not mint tokens when the clock goes backwards', () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(perSecond(1), clock.now);
    expect(bucket.take()).toBe(true);
    clock.advance(-5_000);
    expect(bucket.take()).toBe(false);
    clock.advance(1_000);
    expect(bucket.take()).toBe(true);
  });

  it('reports when it is full again', () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(perSecond(2), clock.now);
    expect(bucket.isFull()).toBe(true);
    bucket.take();
    expect(bucket.isFull()).toBe(false);
    clock.advance(500);
    expect(bucket.isFull()).toBe(true);
  });
});

describe('KeyedRateLimiter', () => {
  it('keeps an independent bucket per key', () => {
    const clock = fakeClock();
    const limiter = new KeyedRateLimiter(perMinute(2), clock.now);
    expect(limiter.take('a')).toBe(true);
    expect(limiter.take('a')).toBe(true);
    expect(limiter.take('a')).toBe(false);
    expect(limiter.retryInMs('a')).toBe(30_000);
    expect(limiter.take('b')).toBe(true);
    expect(limiter.retryInMs('unknown')).toBe(0);
  });

  it('prunes refilled buckets and bounds memory', () => {
    const clock = fakeClock();
    const limiter = new KeyedRateLimiter(perMinute(2), clock.now, 3);
    limiter.take('a');
    limiter.take('b');
    clock.advance(60_000);
    limiter.take('c');
    limiter.prune();
    expect(limiter.size).toBe(1);
    limiter.take('d');
    limiter.take('e');
    limiter.take('f');
    expect(limiter.size).toBeLessThanOrEqual(3);
  });
});

describe('LruCache', () => {
  it('expires entries after the ttl', () => {
    const clock = fakeClock();
    const cache = new LruCache<number>({ maxEntries: 10, ttlMs: 1_000, now: clock.now });
    cache.set('a', 1);
    clock.advance(999);
    expect(cache.get('a')).toBe(1);
    clock.advance(1);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('evicts the least recently used entry', () => {
    const clock = fakeClock();
    const cache = new LruCache<number>({ maxEntries: 2, ttlMs: 60_000, now: clock.now });
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1);
    cache.set('c', 3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
  });
});
