/**
 * Shared pino logger.
 *
 * Pretty multi-line output in dev; single-line JSON in production. Common
 * `service`/`env` fields are bound at the root so every line carries them.
 * Sensitive headers and body fields are redacted at serialisation time so
 * they never leak into the log stream.
 */

import pino from 'pino';
import { config } from './config.js';

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  '*.password',
  '*.token',
  '*.access_token',
  '*.refresh_token',
  'body.password',
  'body.token',
  // Participant PII — email/phone must never reach the log stream. Registration
  // error paths attach them under `fields`/`body`, participant payloads under
  // `payload`/`data`; cover the common one- and two-level nestings pino allows.
  'email',
  'phone',
  '*.email',
  '*.phone',
  '*.*.email',
  '*.*.phone',
];

/**
 * Shared pino options. Exported so the Fastify request logger (`app.ts`) is
 * built from the *same* config — most importantly the same `redact` paths —
 * rather than a hand-maintained copy that can (and did) drift and drop the
 * PII redactions on the request-scoped `req.log`.
 */
export const loggerOptions: pino.LoggerOptions = {
  level: config.LOG_LEVEL,
  base: { service: 'aggregator-api', env: config.NODE_ENV },
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  ...(config.NODE_ENV === 'development'
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
};

export const logger = pino(loggerOptions);
