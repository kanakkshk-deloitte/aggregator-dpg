/**
 * Shared pino logger for the api app.
 *
 * Pretty output in dev, JSON elsewhere. Every line carries `service` and `env`.
 * Secrets and PII fields are redacted.
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
  // Participant PII: email and phone must never be logged, at any of these nesting levels.
  'email',
  'phone',
  '*.email',
  '*.phone',
  '*.*.email',
  '*.*.phone',
];

/**
 * Shared pino options, also used by the Fastify request logger so both apply the same redaction.
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
