/**
 * Testing fake for ConsentLedgerBase (`@aggregator-dpg/consent-ledger/testing`).
 *
 * Other packages import this instead of `./memory`. Adds `seed(rows)` and
 * `buildConsentRecord(overrides)`.
 *
 * @module @aggregator-dpg/consent-ledger/testing
 */

import { InMemoryConsentLedger } from './memory.js';
import type { ConsentRecord } from './interface.js';

export { InMemoryConsentLedger };

/** Fixed timestamp for `buildConsentRecord` defaults. */
const FIXED_NOW = new Date('2026-01-01T00:00:00.000Z');

/**
 * Testing fake for {@link ConsentLedgerBase}.
 *
 * Extends {@link InMemoryConsentLedger}.
 */
export class ConsentLedgerFake extends InMemoryConsentLedger {
  /**
   * Inserts consent records directly, bypassing `recordRegistrationConsent`.
   * Re-seeding the same `id` overwrites the row.
   *
   * @param records - Pre-built consent records to insert.
   */
  seed(records: ConsentRecord[]): void {
    for (const record of records) {
      this.rows.set(record.id, record);
    }
  }
}

/**
 * Constructs a fully-populated {@link ConsentRecord} with valid defaults.
 *
 * Defaults pass Zod validation: a `user` subject on `blue_dot`, version 1 of
 * both documents, `source: 'registration'`, fixed timestamps.
 *
 * @param overrides - Partial fields to apply on top of the defaults.
 * @returns A complete `ConsentRecord`.
 */
export function buildConsentRecord(overrides: Partial<ConsentRecord> = {}): ConsentRecord {
  return {
    id: '00000000-0000-0000-0000-000000000099',
    subjectType: 'user',
    subjectId: '00000000-0000-0000-0000-000000000001',
    termsVersion: 1,
    privacyVersion: 1,
    network: 'blue_dot',
    brand: null,
    source: 'registration',
    acceptedAt: FIXED_NOW,
    validTill: null,
    createdAt: FIXED_NOW,
    ...overrides,
  };
}
