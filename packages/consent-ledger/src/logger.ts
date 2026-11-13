/**
 * Package-local pino logger for the consent-ledger service.
 *
 * Level comes from `LOG_LEVEL` (default `'info'`). Entries carry `service`
 * and `package` fields.
 *
 * @module @aggregator-dpg/consent-ledger
 */

import pino from 'pino';

/** Structured logger used by all concrete consent-ledger implementations. */
export const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  base: {
    service: 'consent-ledger',
    package: '@aggregator-dpg/consent-ledger',
  },
});
