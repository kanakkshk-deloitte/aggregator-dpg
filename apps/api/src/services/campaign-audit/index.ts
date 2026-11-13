/**
 * Process-wide campaign-PII-audit writer accessor, plus the best-effort
 * wrapper every call site uses to record an audit row.
 *
 * Audit failures never fail a campaign. Every write happens after the
 * operation is already durable, so a failure here is only logged.
 *
 * @module @aggregator-dpg/api
 */
import { PostgresCampaignAuditWriter } from '@aggregator-dpg/campaign-audit';
import type { AuditChannel, CampaignAuditWriterBase } from '@aggregator-dpg/campaign-audit';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import { getDb } from '../../db/client.js';
import { logger } from '../../logger.js';

let writer: CampaignAuditWriterBase | null = null;

/**
 * Time limit (ms) for an audit write.
 *
 * Used both as the Postgres `statement_timeout` on the insert and as the
 * {@link safeAudit} race timeout.
 */
const CAMPAIGN_AUDIT_TIMEOUT_MS = 2000;

/**
 * Returns the process-wide {@link CampaignAuditWriterBase}, lazily
 * constructing the Postgres-backed implementation (writing to
 * `campaign_pii_audit`) on first use.
 *
 * @returns The singleton audit writer.
 */
export function getCampaignAuditWriter(): CampaignAuditWriterBase {
  writer ??= new PostgresCampaignAuditWriter(getDb(), CAMPAIGN_AUDIT_TIMEOUT_MS);
  return writer;
}

/**
 * Test helper — installs a replacement audit writer, or clears the override.
 *
 * @param w - The writer to install, or `null` to rebuild the Postgres writer on next use.
 */
export function _setCampaignAuditWriter(w: CampaignAuditWriterBase | null): void {
  writer = w;
}

/** Structured-log context a {@link safeAudit} call site supplies, for the error line it may emit. */
export interface SafeAuditContext {
  /** `operation` field on the emitted log line, e.g. `campaignAudit.requested`. */
  operation: string;
  /** The job id this write is for. */
  correlation_id: string;
  /** The audited channel. */
  channel: AuditChannel;
}

/**
 * Runs an audit write so that its result, failure or stall cannot affect the caller.
 *
 * The write is awaited, bounded by `timeoutMs`. The Postgres writer also sets
 * a `statement_timeout`, so the database cancels a stuck query and frees the
 * connection. A thrown error, a timeout and an error Result are all logged at
 * `error` and never rethrown.
 *
 * @param fn - Thunk that performs the audit write (a `recordX` call on the
 *   process-wide writer).
 * @param ctx - Structured-log context identifying which write this was.
 * @param timeoutMs - Max time to wait before giving up on the write and
 *   logging a timeout failure (default {@link CAMPAIGN_AUDIT_TIMEOUT_MS}).
 */
export async function safeAudit(
  fn: () => Promise<Result<void, BaseError>>,
  ctx: SafeAuditContext,
  timeoutMs = CAMPAIGN_AUDIT_TIMEOUT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      fn(),
      new Promise<Result<void, BaseError>>((_, reject) => {
        timer = setTimeout(() => reject(new Error('audit write timed out')), timeoutMs);
      }),
    ]);
    if (!result.success) {
      logger.error({ ...ctx, status: 'failure', error: result.error.message });
    }
  } catch (cause) {
    logger.error({
      ...ctx,
      status: 'failure',
      error: cause instanceof Error ? cause.message : String(cause),
    });
  } finally {
    // Clear the timer so it does not keep the process alive.
    clearTimeout(timer);
  }
}
