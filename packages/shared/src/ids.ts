import { RIDE_CODE_ALPHABET, RIDE_CODE_LENGTH } from './constants';

const CODE_CHARS = new Set(RIDE_CODE_ALPHABET);

/** Uniform random integer in [0, maxExclusive) without modulo bias. */
function randomInt(maxExclusive: number): number {
  const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive;
  const buf = new Uint32Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(buf);
    const v = buf[0]!;
    if (v < limit) return v % maxExclusive;
  }
}

export function generateRideCode(): string {
  let code = '';
  for (let i = 0; i < RIDE_CODE_LENGTH; i++) {
    code += RIDE_CODE_ALPHABET[randomInt(RIDE_CODE_ALPHABET.length)];
  }
  return code;
}

/** Uppercases and drops separators, so "abc-d23" and "ABC D23" both become "ABCD23". */
export function normalizeRideCode(input: string): string {
  return [...input.toUpperCase()].filter((c) => CODE_CHARS.has(c)).join('');
}

export function isValidRideCode(code: string): boolean {
  return code.length === RIDE_CODE_LENGTH && [...code].every((c) => CODE_CHARS.has(c));
}

/** "ABCD23" -> "ABC-D23" for display. */
export function formatRideCode(code: string): string {
  return code.length === RIDE_CODE_LENGTH ? `${code.slice(0, 3)}-${code.slice(3)}` : code;
}

/**
 * RFC 4122 v4 UUID. Falls back to getRandomValues where randomUUID is missing
 * (it is only exposed in secure contexts).
 */
export function uuid(): string {
  const c = globalThis.crypto;
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** URL-safe random string used as a rider's private reconnect secret. */
export function randomSecret(bytes = 24): string {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(bytes));
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
