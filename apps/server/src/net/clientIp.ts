/** "::ffff:10.0.0.1" -> "10.0.0.1", so IPv4 clients key the same way on dual-stack sockets. */
export function normalizeIp(ip: string): string {
  const s = ip.trim();
  return s.toLowerCase().startsWith('::ffff:') && s.includes('.') ? s.slice(7) : s;
}

/**
 * The client address, honouring X-Forwarded-For only for `trustedHops` proxies in front of us.
 * Each proxy appends the address it saw, so with one trusted proxy the client is the LAST entry;
 * anything to the left of it is client-supplied and must not be believed.
 */
export function resolveClientIp(
  remoteAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  trustedHops: number,
): string {
  const peer = normalizeIp(remoteAddress ?? '') || 'unknown';
  if (trustedHops <= 0 || forwardedFor === undefined) return peer;
  const chain = (Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // Nearest first: our peer, then what each trusted proxy reported.
  const hops = [peer, ...chain.reverse()];
  return normalizeIp(hops[Math.min(trustedHops, hops.length - 1)]!);
}
