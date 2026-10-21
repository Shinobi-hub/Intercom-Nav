import { describe, expect, it } from 'vitest';
import { normalizeIp, resolveClientIp } from './clientIp';
import { createOriginPolicy } from './originPolicy';

describe('resolveClientIp', () => {
  it('ignores X-Forwarded-For unless proxies are trusted', () => {
    expect(resolveClientIp('10.0.0.5', '1.2.3.4', 0)).toBe('10.0.0.5');
    expect(resolveClientIp('10.0.0.5', undefined, 1)).toBe('10.0.0.5');
  });

  it('takes the entry our proxy appended, not what the client claimed', () => {
    // Client sent "X-Forwarded-For: 6.6.6.6"; the proxy appended the real address.
    expect(resolveClientIp('10.0.0.5', '6.6.6.6, 203.0.113.9', 1)).toBe('203.0.113.9');
    expect(resolveClientIp('10.0.0.5', ['6.6.6.6', '203.0.113.9'], 1)).toBe('203.0.113.9');
  });

  it('walks back one entry per trusted hop', () => {
    expect(resolveClientIp('10.0.0.5', '198.51.100.1, 10.0.0.9', 2)).toBe('198.51.100.1');
    // More trusted hops than entries: the furthest address we know.
    expect(resolveClientIp('10.0.0.5', '198.51.100.1', 5)).toBe('198.51.100.1');
  });

  it('normalizes IPv4-mapped IPv6 addresses', () => {
    expect(normalizeIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeIp('::1')).toBe('::1');
    expect(resolveClientIp('::ffff:10.1.1.1', undefined, 0)).toBe('10.1.1.1');
    expect(resolveClientIp(undefined, undefined, 0)).toBe('unknown');
  });
});

describe('origin policy', () => {
  const dev = createOriginPolicy({ allowedOrigins: ['capacitor://localhost', 'https://localhost'], allowLocalhost: true });
  const prod = createOriginPolicy({ allowedOrigins: ['capacitor://localhost'], allowLocalhost: false });

  it('allows requests without an Origin (native and server-side clients)', () => {
    expect(prod.allowsRequest(undefined, 'ride.example.com')).toBe(true);
  });

  it('allows same-origin pages', () => {
    expect(prod.allowsRequest('https://ride.example.com', 'ride.example.com')).toBe(true);
    expect(prod.allowsRequest('http://192.168.1.20:8787', '192.168.1.20:8787')).toBe(true);
    expect(prod.allowsRequest('https://evil.example', 'ride.example.com')).toBe(false);
  });

  it('allows configured origins, case- and slash-insensitively', () => {
    expect(prod.allowsRequest('capacitor://localhost', 'ride.example.com')).toBe(true);
    expect(dev.allowsCrossOrigin('HTTPS://LOCALHOST/')).toBe(true);
    expect(prod.allowsCrossOrigin('https://localhost')).toBe(false);
  });

  it('allows any localhost port in development only', () => {
    expect(dev.allowsCrossOrigin('http://localhost:5173')).toBe(true);
    expect(dev.allowsCrossOrigin('http://127.0.0.1:4173')).toBe(true);
    expect(dev.allowsCrossOrigin('http://localhost.evil.example:5173')).toBe(false);
    expect(prod.allowsCrossOrigin('http://localhost:5173')).toBe(false);
  });

  it('rejects malformed and opaque origins', () => {
    expect(dev.allowsCrossOrigin('null')).toBe(false);
    expect(dev.allowsRequest('null', 'localhost:8787')).toBe(false);
    expect(dev.allowsCrossOrigin('not a url')).toBe(false);
  });
});
