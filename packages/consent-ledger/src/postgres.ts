/**
 * Drizzle-backed consent ledger (`@aggregator-dpg/consent-ledger`).
 *
 * Inserts one row into `consent_record` (default `source = 'registration'`)
 * with a server-set `acceptedAt` and the typed `user_id` / `org_id` link.
 * Database errors are returned as `UpstreamError`. Every call is logged.
 *
 * @module @aggregator-dpg/consent-ledger/postgres
 */

import type { PgDatabase } from 'drizzle-orm/pg-core';
import { consentRecord } from '@aggregator-dpg/db-schema/schema';
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

// Loose type so both a `db` and a `tx` handle are accepted.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbHandle = PgDatabase<any, any, any>;

/**
 * Postgres-backed implementation of {@link ConsentLedgerBase}.
 *
 * Takes a Drizzle database handle or transaction.
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
   * Returns a ledger writing through `executor` (a Drizzle transaction).
   *
   * @param executor - The caller's Drizzle transaction, or nothing.
   * @returns A ledger bound to it (this ledger when none is given).
   */
  override withExecutor(executor: unknown): PostgresConsentLedger {
    if (executor === undefined || executor === null) return this;
    return new PostgresConsentLedger(executor as DbHandle);
  }

  /**
   * Inserts one consent record into `consent_record`.
   *
   * `source` defaults to `'registration'`; `acceptedAt` is now. Never throws.
   *
   * @param input - Registration-consent payload.
   * @returns `ok(ConsentRecord)`; `err(ValidationError | UpstreamError | DomainError)` on failure.
   */
  override async recordRegistrationConsent(
    input: RecordConsentInput,
  ): Promise<Result<ConsentRecord, BaseError>> {
    const start = Date.now();
    const operation = 'consentLedger.recordRegistrationConsent';

    // Validate here too, so a direct caller cannot insert a malformed row.
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
        .insert(consentRecord)
        .values({
          subjectType: validInput.subjectType,
          subjectId: validInput.subjectId,
          userId: validInput.subjectType === 'user' ? validInput.subjectId : null,
          orgId: validInput.subjectType === 'organisation' ? validInput.subjectId : null,
          termsVersion: validInput.termsVersion,
          privacyVersion: validInput.privacyVersion,
          network: validInput.network,
          brand: validInput.brand ?? null,
          source: validInput.source ?? 'registration',
          acceptedAt: now,
          validTill: validInput.validTill ?? null,
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
        validTill: row.validTill ?? null,
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
