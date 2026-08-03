/**
 * In-memory ConsentLedger — Map-backed, used by unit tests in this package.
 *
 * Cross-package consumers should import the testing fake from `./testing`
 * instead (which extends this with a `seed()` / `buildConsentRecord()` helper).
 *
 * Every call to `recordRegistrationConsent` appends a new row with a
 * generated `id` and a deterministic `createdAt` / `acceptedAt` so assertions
 * are snapshot-stable.
 *
 * @module @aggregator-dpg/consent-ledger/memory
 */

import { ok } from '@aggregator-dpg/shared-primitives/result';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';

import { ConsentLedgerBase, type ConsentRecord, type RecordConsentInput } from './interface.js';

/** Fixed ISO timestamp used for all in-memory rows for deterministic testing. */
const FIXED_NOW = new Date('2026-01-01T00:00:00.000Z');

/**
 * In-memory implementation of {@link ConsentLedgerBase}.
 *
 * Rows are stored in insertion order in a `Map` keyed by generated id.
 * No deduplication is applied — the ledger is append-only by design.
 */
export class InMemoryConsentLedger extends ConsentLedgerBase {
  /** Internal append-only store of consent records. */
  protected readonly rows: Map<string, ConsentRecord> = new Map();
  private nextId = 1;

  /**
   * Appends a consent record using in-memory state.
   *
   * Always returns `ok(record)`; never fails.
   *
   * @param input - Validated registration-consent payload.
   * @returns `ok(ConsentRecord)` with the newly stored row.
   */
  override recordRegistrationConsent(
    input: RecordConsentInput,
  ): Promise<Result<ConsentRecord, BaseError>> {
    const id = `mem-consent-${this.nextId++}`;
    const record: ConsentRecord = {
      id,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      termsVersion: input.termsVersion,
      privacyVersion: input.privacyVersion,
      network: input.network,
      brand: input.brand ?? null,
      source: input.source ?? 'registration',
      acceptedAt: FIXED_NOW,
      createdAt: FIXED_NOW,
    };
    this.rows.set(id, record);
    return Promise.resolve(ok(record));
  }

  /**
   * Returns all stored consent records in insertion order.
   *
   * Intended for package-internal unit tests only; external consumers
   * should not depend on this method.
   *
   * @returns Array of all consent records stored so far.
   */
  list(): ConsentRecord[] {
    return Array.from(this.rows.values());
  }
}
