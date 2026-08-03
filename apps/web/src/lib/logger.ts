/**
 * Shared pino logger for the Next.js BFF (server side only).
 *
 * Usage:
 *
 *   import { logger } from '@/lib/logger';
 *   const log = logger.child({ reqId, route: '/api/aggregator/register' });
 *   log.info({ status: 'success', latency_ms }, 'short message');
 *
 * Edge runtime cannot load pino. BFF routes that use this logger must
 * declare `export const runtime = 'nodejs'`.
 */

import pino from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';
const isDev = process.env.NODE_ENV !== 'production';

export const logger = pino({
  level,
  base: { service: 'aggregator-web-bff', env: process.env.NODE_ENV ?? 'development' },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.token',
      '*.access_token',
      '*.refresh_token',
      // Participant PII — never log email/phone (registration/proxy paths carry
      // them in bodies and error fields). Cover the common one/two-level nestings.
      'email',
      'phone',
      '*.email',
      '*.phone',
      '*.*.email',
      '*.*.phone',
    ],
    censor: '[REDACTED]',
  },
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss.l',
            singleLine: false,
            ignore: 'pid,hostname,service,env',
          },
        },
      }
    : {}),
});

/**
 * Generates or extracts a request id, returning the value to forward to the
 * API and to log against. Reuses an inbound `x-request-id` header when
 * present (preserves trace continuity), otherwise mints a fresh one.
 */
export function pickRequestId(headers: Headers): string {
  const incoming = headers.get('x-request-id');
  if (incoming && incoming.length > 0 && incoming.length <= 128) return incoming;
  const rand = Math.random().toString(16).slice(2, 10);
  return `req-${Date.now().toString(36)}-${rand}`;
}
