/**
 * Drizzle-backed ConsentLedger — real production implementation.
 *
 * Inserts one row into `aggregator_consent_record` with `source = 'registration'`
 * and a server-stamped `acceptedAt`. Any Drizzle / database error is mapped to
 * a typed `UpstreamError` so the caller never sees a thrown exception.
 *
 * Structured log entries are emitted on every call (success and failure) with
 * `operation`, `status`, `latency_ms`, and `error`/`error_type` fields per
 * the repo logging-observability rule.
 *
 * @module @aggregator-dpg/consent-ledger/postgres
 */

import type { PgDatabase } from 'drizzle-orm/pg-core';
import { aggregatorConsentRecord } from '@aggregator-dpg/db-schema/schema';
import {
  UpstreamError,
  DomainError,
  ValidationError,
} from '@aggregator-dpg/shared-primitives/errors';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import { err, ok } from '@aggregator-dpg/shared-primitives/result';
import type { Result } from '@aggregator-dpg/shared-primitives/result';

import {
  ConsentLedgerBase,
  RecordConsentInputSchema,
  type ConsentRecord,
  type RecordConsentInput,
} from './interface.js';
import { logger } from './logger.js';

// Drizzle is generic over its schema map; we only need a "queryable" handle.
// Accept the loosest viable type so both `db` and `tx` callers pass through.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbHandle = PgDatabase<any, any, any>;

/**
 * Postgres-backed implementation of {@link ConsentLedgerBase}.
 *
 * Requires a Drizzle database handle (or transaction) at construction time.
 * The caller (routes/services in apps/api) injects the DB client.
 */
export class PostgresConsentLedger extends ConsentLedgerBase {
  /**
   * Constructs the Postgres consent ledger.
   *
   * @param db - A Drizzle PgDatabase instance (or transaction) to run queries against.
   */
  constructor(private readonly db: DbHandle) {
    super();
  }

  /**
   * Inserts one registration-consent record into `aggregator_consent_record`.
   *
   * Sets `source = 'registration'` and `acceptedAt = now()` on every call.
   * On DB failure returns `err(UpstreamError)`; if Drizzle returns no row
   * returns `err(DomainError)`. Never throws.
   *
   * @param input - Validated registration-consent payload.
   * @returns `ok(ConsentRecord)` with the persisted row on success, or
   *   `err(BaseError)` on any database error.
   */
  override async recordRegistrationConsent(
    input: RecordConsentInput,
  ): Promise<Result<ConsentRecord, BaseError>> {
    const start = Date.now();
    const operation = 'consentLedger.recordRegistrationConsent';

    // Validate the input at the ledger boundary so a caller that bypasses
    // the route-level schema (e.g. a direct service call) cannot insert a
    // malformed row. Return err rather than throwing — boundary rule.
    const parsed = RecordConsentInputSchema.safeParse(input);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      logger.error({
        operation,
        status: 'failure',
        error: message,
        error_type: 'ValidationError',
        latency_ms: Date.now() - start,
      });
      return err(
        new ValidationError(`Invalid RecordConsentInput: ${message}`, {
          code: 'CONSENT_INPUT_INVALID',
          details: { issues: parsed.error.issues },
        }),
      );
    }
    const validInput = parsed.data;

    try {
      const now = new Date();

      const inserted = await this.db
        .insert(aggregatorConsentRecord)
        .values({
          subjectType: validInput.subjectType,
          subjectId: validInput.subjectId,
          termsVersion: validInput.termsVersion,
          privacyVersion: validInput.privacyVersion,
          network: validInput.network,
          brand: validInput.brand ?? null,
          source: input.source ?? 'registration',
          acceptedAt: now,
        })
        .returning();

      const row = inserted[0];
      if (!row) {
        logger.error({
          operation,
          status: 'failure',
          error: 'no row returned after insert',
          error_type: 'DomainError',
          latency_ms: Date.now() - start,
        });
        return err(
          new DomainError('consent record insert returned no row', {
            code: 'CONSENT_INSERT_EMPTY',
          }),
        );
      }

      logger.info({
        operation,
        status: 'success',
        latency_ms: Date.now() - start,
        subject_type: validInput.subjectType,
        network: validInput.network,
      });

      const record: ConsentRecord = {
        id: row.id,
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        termsVersion: row.termsVersion,
        privacyVersion: row.privacyVersion,
        network: row.network,
        brand: row.brand ?? null,
        source: row.source,
        acceptedAt: row.acceptedAt,
        createdAt: row.createdAt,
      };

      return ok(record);
    } catch (e) {
      const cause = e as Error;
      logger.error({
        operation,
        status: 'failure',
        error: cause.message,
        error_type: cause.constructor.name,
        latency_ms: Date.now() - start,
      });
      return err(
        new UpstreamError(`consent record INSERT failed: ${cause.message}`, {
          cause,
          code: 'CONSENT_INSERT_FAILED',
        }),
      );
    }
  }
}
