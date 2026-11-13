/**
 * Shared pino logger for the Next.js BFF. Server-only.
 *
 * Usage: `logger.child({ reqId, route }).info({ status: 'success' }, 'msg')`.
 *
 * Pino does not run on the Edge runtime. Routes using this logger must
 * declare `export const runtime = 'nodejs'`.
 */

import { randomUUID } from 'node:crypto';
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
      // Never log participant email or phone, at up to two levels of nesting.
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
 * Returns the request id to log and forward to the API.
 *
 * Reuses an inbound `x-request-id` (up to 128 chars), otherwise creates one.
 *
 * @param headers - The inbound request headers.
 * @returns The request id.
 */
export function pickRequestId(headers: Headers): string {
  const incoming = headers.get('x-request-id');
  if (incoming && incoming.length > 0 && incoming.length <= 128) return incoming;
  const rand = randomUUID().slice(0, 8);
  return `req-${Date.now().toString(36)}-${rand}`;
}
