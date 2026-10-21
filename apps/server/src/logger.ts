import { createRequire } from 'node:module';
import type { FastifyServerOptions } from 'fastify';
import type { Config } from './config';

/**
 * Safety net: handlers never log payloads, but if a location, secret or token ever ends up in a
 * log object (top level or one level down), it is censored.
 */
const SENSITIVE_KEYS = ['secret', 'token', 'credential', 'location', 'fix', 'lat', 'lng', 'near', 'destination', 'waypoints', 'geometry'];
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  ...SENSITIVE_KEYS,
  ...SENSITIVE_KEYS.map((k) => `*.${k}`),
];

export function loggerOptions(config: Config): FastifyServerOptions['logger'] {
  if (config.logLevel === 'silent') return false;
  const pretty = process.stdout.isTTY ? resolvePinoPretty() : null;
  return {
    level: config.logLevel,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    ...(pretty
      ? { transport: { target: pretty, options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' } } }
      : {}),
  };
}

/** pino-pretty is a dev dependency; production installs may not have it. */
function resolvePinoPretty(): string | null {
  try {
    return createRequire(import.meta.url).resolve('pino-pretty');
  } catch {
    return null;
  }
}
