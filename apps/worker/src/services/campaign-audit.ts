/**
 * Campaign audit writer access for the worker app.
 *
 * The worker writes the `completed` audit row when a campaign job ends, and
 * when the watchdog fails a stalled job. Mirrors the API's campaign-audit service.
 *
 * @module @aggregator-dpg/worker
 */
import { PostgresCampaignAuditWriter } from '@aggregator-dpg/campaign-audit';
import type { CampaignAuditWriterBase } from '@aggregator-dpg/campaign-audit';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import { getDb } from '../db.js';

let writer: CampaignAuditWriterBase | null = null;

/**
 * Returns the process-wide audit writer, creating the Postgres one on first use.
 *
 * @returns The singleton audit writer.
 */
export function getCampaignAuditWriter(): CampaignAuditWriterBase {
  writer ??= new PostgresCampaignAuditWriter(getDb());
  return writer;
}

/**
 * Replaces the audit writer, for tests.
 *
 * @param w - The writer to use, or `null` to rebuild the real one on next use.
 */
export function _setCampaignAuditWriter(w: CampaignAuditWriterBase | null): void {
  writer = w;
}

/** Logger used by {@link safeAudit}. */
export interface SafeAuditLogger {
  error(obj: object): void;
}

/** Log fields for the error line {@link safeAudit} may emit. */
export interface SafeAuditContext {
  /** `operation` field on the emitted log line, e.g. `campaignAudit.completed`. */
  operation: string;
  /** The `campaign_job.id` this write is for. */
  job_id: string;
  /** The audited channel. */
  channel: string;
}

/**
 * Runs an audit write and logs any failure without throwing.
 *
 * Handles both a thrown error and an `err` result. No timeout, since no
 * request is waiting on the write.
 *
 * @param fn - The audit write. Resolving `undefined` (no writer) is a no-op.
 * @param log - Structured logger to emit the failure line on.
 * @param ctx - Structured-log context identifying which write this was.
 */
export async function safeAudit(
  fn: () => Promise<Result<void, BaseError> | undefined>,
  log: SafeAuditLogger,
  ctx: SafeAuditContext,
): Promise<void> {
  try {
    const result = await fn();
    if (result && !result.success) {
      log.error({ ...ctx, status: 'failure', error: result.error.message });
    }
  } catch (cause) {
    log.error({
      ...ctx,
      status: 'failure',
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
}
