import pino from 'pino';
import { config } from './config.js';

/**
 * Redaction paths for the worker logger, so email, phone and secrets are not logged.
 *
 * Covers up to two levels of nesting. Pino has no recursive wildcard, so
 * deeper paths must be added explicitly.
 */
export const REDACT_PATHS = [
  '*.password',
  '*.token',
  '*.access_token',
  '*.refresh_token',
  'email',
  'phone',
  '*.email',
  '*.phone',
  '*.*.email',
  '*.*.phone',
];

export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: 'aggregator-worker', env: config.NODE_ENV },
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
});
