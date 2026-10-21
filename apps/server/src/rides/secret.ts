import { createHash, timingSafeEqual } from 'node:crypto';

export function hashSecret(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

/** Constant-time comparison of a presented secret against a stored hash. */
export function secretMatches(storedHash: Buffer, secret: string): boolean {
  const candidate = hashSecret(secret);
  return candidate.length === storedHash.length && timingSafeEqual(candidate, storedHash);
}
