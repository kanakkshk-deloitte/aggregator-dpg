/**
 * In-memory consent ledger (`@aggregator-dpg/consent-ledger`), for unit tests
 * in this package. Other packages use the fake from `./testing`.
 *
 * Each row gets a generated `id` and a fixed `createdAt` / `acceptedAt`.
 *
 * @module @aggregator-dpg/consent-ledger/memory
 */

import { ok } from '@aggregator-dpg/shared-primitives/result';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';

import { ConsentLedgerBase, type ConsentRecord, type RecordConsentInput } from './interface.js';

/** Fixed timestamp for all in-memory rows. */
const FIXED_NOW = new Date('2026-01-01T00:00:00.000Z');

/**
 * In-memory implementation of {@link ConsentLedgerBase}.
 *
 * Rows are kept in insertion order, keyed by generated id. No deduplication.
 */
export class InMemoryConsentLedger extends ConsentLedgerBase {
  /** Internal append-only store of consent records. */
  protected readonly rows: Map<string, ConsentRecord> = new Map();
  private nextId = 1;

  /**
   * Appends a consent record. Never fails.
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
      validTill: input.validTill ?? null,
      createdAt: FIXED_NOW,
    };
    this.rows.set(id, record);
    return Promise.resolve(ok(record));
  }

  /**
   * Returns this ledger: in memory there is no transaction to bind to.
   *
   * @param _executor - Ignored.
   * @returns This ledger.
   */
  override withExecutor(_executor: unknown): this {
    return this;
  }

  /**
   * Returns all stored consent records in insertion order. For this package's tests.
   *
   * @returns Array of all consent records stored so far.
   */
  list(): ConsentRecord[] {
    return Array.from(this.rows.values());
  }
}
