/**
 * Drizzle-backed audit writer.
 *
 * Only inserts rows. Do not add update or delete.
 *
 * @module @aggregator-dpg/campaign-audit/postgres
 */
import { sql } from 'drizzle-orm';
import { campaignPiiAudit } from '@aggregator-dpg/db-schema/schema';
import { ok, err } from '@aggregator-dpg/shared-primitives/result';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import { UpstreamError, type BaseError } from '@aggregator-dpg/shared-primitives/errors';
import {
  CampaignAuditWriterBase,
  type RequestedAuditInput,
  type CompletedAuditInput,
} from './interface.js';

/**
 * The `campaign_pii_audit` insert row shape, derived from {@link campaignPiiAudit}
 * so a wrong key is a compile error.
 */
type AuditRow = typeof campaignPiiAudit.$inferInsert;

/** The subset of an insert builder this writer needs (shared by {@link AuditDb} and {@link AuditTx}). */
type AuditInsertable = (table: typeof campaignPiiAudit) => {
  values: (row: AuditRow) => Promise<unknown>;
};

/**
 * The transaction handle passed to the callback given to {@link AuditDb.transaction}.
 * Needs `execute` (to issue `SET LOCAL statement_timeout`) alongside `insert`.
 */
export interface AuditTx {
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
  insert: AuditInsertable;
}

/**
 * The database handle this writer needs. `transaction` is only used when the
 * writer has a `statementTimeoutMs`.
 */
export interface AuditDb {
  insert: AuditInsertable;
  transaction?: <T>(fn: (tx: AuditTx) => Promise<T>) => Promise<T>;
}

/**
 * {@link CampaignAuditWriterBase} implementation backed by the
 * `campaign_pii_audit` Postgres table via Drizzle.
 *
 * Every method goes through the private {@link insert} helper. There is no
 * update, delete or read path.
 */
export class PostgresCampaignAuditWriter extends CampaignAuditWriterBase {
  /**
   * Creates a writer.
   *
   * @param db - Drizzle-like handle used to insert rows into `campaign_pii_audit`.
   * @param statementTimeoutMs - When set, each insert runs in a transaction with this
   *   `statement_timeout`, so Postgres cancels a stalled query.
   */
  constructor(
    private readonly db: AuditDb,
    private readonly statementTimeoutMs?: number,
  ) {
    super();
  }

  /**
   * Inserts the `requested` row when the API accepts a campaign action.
   *
   * @param input - Request-time fields.
   * @returns `ok(void)` once inserted; `err(BaseError)` if the insert fails.
   */
  override async recordRequested(input: RequestedAuditInput): Promise<Result<void, BaseError>> {
    return this.insert({
      correlationId: input.correlationId,
      event: 'requested' as const,
      channel: input.channel,
      actorUserId: input.actorUserId,
      actorSignalstackOrgId: input.actorSignalstackOrgId,
      actorAzp: input.actorAzp ?? null,
      piiFields: input.piiFields,
      itemCount: input.itemCount,
      requestedAt: input.requestedAt,
      requestedCount: input.itemCount,
      network: input.network ?? null,
      instance: input.instance ?? null,
      requestIp: input.requestIp ?? null,
      purpose: input.purpose ?? null,
      endpoint: input.endpoint,
      traceId: input.traceId ?? null,
      // No `outcome` yet: nothing has happened.
    });
  }

  /**
   * Inserts the `completed` row once a campaign job reaches a terminal status.
   *
   * @param input - Outcome and counts, keyed by the `recordRequested` `correlationId`.
   * @returns `ok(void)` once inserted; `err(BaseError)` if the insert fails.
   */
  override async recordCompleted(input: CompletedAuditInput): Promise<Result<void, BaseError>> {
    return this.insert({
      correlationId: input.correlationId,
      event: 'completed' as const,
      channel: input.channel,
      actorSignalstackOrgId: input.actorSignalstackOrgId,
      outcome: input.outcome,
      completedAt: input.completedAt,
      destination: input.destination ?? null,
      resolvedCount: input.resolvedCount ?? null,
      skippedCount: input.skippedCount ?? null,
      failedCount: input.failedCount ?? null,
      sentCount: input.sentCount ?? null,
      errorCode: input.errorCode ?? null,
      recipientRef: input.recipientRef ?? null,
    });
  }

  /**
   * Inserts one row. Shared by both public methods.
   *
   * @param row - The `campaign_pii_audit` row to insert.
   * @returns `ok(void)` on success; `err(UpstreamError)` if the insert fails.
   */
  private async insert(row: AuditRow): Promise<Result<void, BaseError>> {
    try {
      if (this.statementTimeoutMs !== undefined && this.db.transaction) {
        const timeoutMs = this.statementTimeoutMs;
        await this.db.transaction(async (tx) => {
          // `SET LOCAL` resets at COMMIT/ROLLBACK, so it is safe on a pooled connection.
          // SET takes no bind parameters; the value is an internal number, not user input.
          await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${timeoutMs}ms'`));
          await tx.insert(campaignPiiAudit).values(row);
        });
      } else {
        await this.db.insert(campaignPiiAudit).values(row);
      }
      return ok(undefined);
    } catch (cause) {
      return err(
        new UpstreamError('campaign audit insert failed', {
          cause,
          code: 'CAMPAIGN_AUDIT_INSERT_FAILED',
        }),
      );
    }
  }
}
