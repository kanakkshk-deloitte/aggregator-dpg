import pino from 'pino';
import { config } from './config.js';

/**
 * Redaction paths for the worker logger. The worker processes participant CSVs,
 * so email/phone (and secrets) must never reach the log stream. Covers the
 * common one/two-level nestings pino supports (e.g. row payloads under
 * `payload`/`data`, error detail under `err`/`fields`); pino has no recursive
 * wildcard, so deeper nestings must be added explicitly if they appear.
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
