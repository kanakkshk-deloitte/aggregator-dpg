/**
 * Worker-side DB access for campaign jobs.
 *
 * The API creates jobs; the worker reads them and writes item and job status.
 * Apps cannot import each other, so this mirrors the API's `campaign-job-store`.
 * `deriveJobStatus` must stay in step with the API's copy.
 *
 * @module @aggregator-dpg/worker
 */
import { and, count, eq, lt, sql } from 'drizzle-orm';
import {
  campaignJob,
  campaignJobItem,
  type CampaignMetadataPair,
} from '@aggregator-dpg/db-schema/schema';
import { getDb } from '../db.js';

export type CampaignJobStatus = 'queued' | 'processing' | 'partial' | 'completed' | 'failed';
export type CampaignJobItemStatus =
  | 'pending'
  | 'resolved'
  | 'submitted'
  | 'sent'
  | 'skipped_not_owned'
  | 'skipped_no_contact'
  | 'duplicate_active'
  | 'failed';

/** Item statuses that are deliberate no-ops rather than failures. */
export const SKIPPED_ITEM_STATUSES: readonly CampaignJobItemStatus[] = [
  'skipped_not_owned',
  'skipped_no_contact',
  'duplicate_active',
];

/**
 * Item statuses a handler does not act on again when a job retries.
 *
 * `resolved` is not terminal; it means the data was fetched. Must match the API's copy.
 */
export const TERMINAL_ITEM_STATUSES: readonly CampaignJobItemStatus[] = [
  'submitted',
  'sent',
  'skipped_not_owned',
  'skipped_no_contact',
  'duplicate_active',
  'failed',
];

/** {@link TERMINAL_ITEM_STATUSES} as a SQL `NOT IN (...)` list. */
const TERMINAL_SQL_LIST = TERMINAL_ITEM_STATUSES.map((s) => `'${s}'`).join(',');

/** Job statuses a job can no longer move out of. */
export const TERMINAL_JOB_STATUSES: readonly CampaignJobStatus[] = [
  'partial',
  'completed',
  'failed',
];
export type CampaignChannel = 'export' | 'email' | 'voice';

export interface ProcessingJobItem {
  itemId: string;
  action: string | null;
  status: CampaignJobItemStatus;
  /**
   * Provider batch id this item was submitted under (voice: the Raya batch id).
   * Set with `submitted` by {@link markSubmitted}. The voice handler checks it
   * to avoid a second dispatch. Stored in the `raya_batch_id` column.
   */
  providerBatchRef: string | null;
}

/** Args for {@link markSubmitted}. */
export interface MarkSubmittedArgs {
  /** The provider batch id this item was submitted under (voice: the Raya batch id). */
  providerBatchRef: string;
  /** External id the submission produced, when the provider returns one synchronously. */
  providerRef?: string;
}

export interface ProcessingJob {
  id: string;
  channel: CampaignChannel;
  status: CampaignJobStatus;
  signalstackOrgId: string;
  metadata: CampaignMetadataPair[];
  content: Record<string, unknown>;
  requestedBy: string;
  requestId: string | null;
  /** Set once the user-visible notification was sent; a retry must not re-send. */
  notifiedAt: Date | null;
  items: ProcessingJobItem[];
}

export interface JobStatusCounts {
  total: number;
  pending: number;
  resolved: number;
  submitted: number;
  sent: number;
  skipped_not_owned: number;
  skipped_no_contact: number;
  duplicate_active: number;
  failed: number;
}

/**
 * Derives the job status from item counts.
 *
 * Must match the API's `deriveJobStatus`.
 *
 * @param c - The job's item-status tally.
 * @returns The derived job status.
 */
export function deriveJobStatus(c: JobStatusCounts): CampaignJobStatus {
  if (c.pending > 0) return 'processing';
  if (c.total === 0) return 'completed';
  const succeeded = c.resolved + c.submitted + c.sent;
  // Skips are not failures.
  if (c.failed === 0) return 'completed';
  if (succeeded === 0) return 'failed';
  return 'partial';
}

/** Loads a job and its items. Not org-scoped; the jobId comes from the queue. */
export async function getJobForProcessing(jobId: string): Promise<ProcessingJob | null> {
  const rows = await getDb().select().from(campaignJob).where(eq(campaignJob.id, jobId)).limit(1);
  const row = rows[0];
  if (!row) return null;
  const items = await getDb()
    .select()
    .from(campaignJobItem)
    .where(eq(campaignJobItem.jobId, jobId))
    .orderBy(campaignJobItem.createdAt);
  return {
    id: row.id,
    channel: row.channel,
    status: row.status,
    signalstackOrgId: row.signalstackOrgId,
    metadata: row.metadata,
    content: row.content,
    requestedBy: row.requestedBy,
    requestId: row.requestId,
    notifiedAt: row.notifiedAt,
    items: items.map((i) => ({
      itemId: i.itemId,
      action: i.action,
      status: i.status,
      // Column `raya_batch_id`.
      providerBatchRef: i.rayaBatchId,
    })),
  };
}

/**
 * Counts a job's items by status.
 *
 * Failure paths call `failPendingItems` first so no item is left `pending`.
 */
export async function countItems(jobId: string): Promise<JobStatusCounts> {
  const rows = await getDb()
    .select({ status: campaignJobItem.status, n: count() })
    .from(campaignJobItem)
    .where(eq(campaignJobItem.jobId, jobId))
    .groupBy(campaignJobItem.status);
  const counts: JobStatusCounts = {
    total: 0,
    pending: 0,
    resolved: 0,
    submitted: 0,
    sent: 0,
    skipped_not_owned: 0,
    skipped_no_contact: 0,
    duplicate_active: 0,
    failed: 0,
  };
  for (const r of rows) {
    const n = Number(r.n);
    counts[r.status] += n;
    counts.total += n;
  }
  return counts;
}

/** Sets an item's status. A terminal item is not overwritten. */
export async function markItem(
  jobId: string,
  itemId: string,
  status: CampaignJobItemStatus,
  reason?: string,
  providerRef?: string,
): Promise<void> {
  await getDb()
    .update(campaignJobItem)
    .set({
      status,
      // Skip reasons go in `skip_reason`, not `error_reason`.
      skipReason: SKIPPED_ITEM_STATUSES.includes(status) ? (reason ?? null) : null,
      errorReason: SKIPPED_ITEM_STATUSES.includes(status) ? null : (reason ?? null),
      ...(providerRef !== undefined ? { providerRef } : {}),
      updatedAt: new Date(),
      ...(TERMINAL_ITEM_STATUSES.includes(status) ? { completedAt: new Date() } : {}),
    })
    .where(
      and(
        eq(campaignJobItem.jobId, jobId),
        eq(campaignJobItem.itemId, itemId),
        sql.raw(`"campaign_job_item"."status" NOT IN (${TERMINAL_SQL_LIST})`),
      ),
    );
}

/**
 * Marks an item `submitted` to the voice provider and stores its batch id.
 *
 * No-op when the item is already terminal, like {@link markItem}.
 *
 * @param jobId - The job the item belongs to.
 * @param itemId - The item that was submitted.
 * @param args - The provider batch id (voice: the Raya batch id), and
 *   optionally a provider ref returned synchronously by the submission call.
 */
export async function markSubmitted(
  jobId: string,
  itemId: string,
  args: MarkSubmittedArgs,
): Promise<void> {
  const now = new Date();
  await getDb()
    .update(campaignJobItem)
    .set({
      status: 'submitted',
      rayaBatchId: args.providerBatchRef,
      ...(args.providerRef !== undefined ? { providerRef: args.providerRef } : {}),
      updatedAt: now,
      completedAt: now, // 'submitted' is terminal
    })
    .where(
      and(
        eq(campaignJobItem.jobId, jobId),
        eq(campaignJobItem.itemId, itemId),
        sql.raw(`"campaign_job_item"."status" NOT IN (${TERMINAL_SQL_LIST})`),
      ),
    );
}

/**
 * Stores the raw provider response for a job (voice: the Raya create + start payload).
 *
 * @param jobId - The job to stamp.
 * @param response - Arbitrary provider payload, stored as-is.
 */
export async function setProviderResponse(jobId: string, response: unknown): Promise<void> {
  await getDb()
    .update(campaignJob)
    .set({ providerResponse: response, updatedAt: new Date() })
    .where(eq(campaignJob.id, jobId));
}

/** Sets `last_progress_at` to now for the watchdog. */
export async function heartbeat(jobId: string): Promise<void> {
  await getDb()
    .update(campaignJob)
    .set({ lastProgressAt: new Date() })
    .where(eq(campaignJob.id, jobId));
}

/** Sets the job status and an optional error reason. */
export async function setJobStatus(
  jobId: string,
  status: CampaignJobStatus,
  errorReason?: string,
): Promise<void> {
  await getDb()
    .update(campaignJob)
    .set({
      status,
      ...(errorReason !== undefined ? { errorReason } : {}),
      updatedAt: new Date(),
      ...(TERMINAL_JOB_STATUSES.includes(status) ? { completedAt: new Date() } : {}),
    })
    .where(eq(campaignJob.id, jobId));
}

/** The derived job status and the counts it came from. */
export interface RollUpResult {
  status: CampaignJobStatus;
  counts: JobStatusCounts;
}

/**
 * Derives and saves the job status from its item counts.
 *
 * Also returns the counts, which the audit write needs.
 */
export async function rollUpStatus(jobId: string): Promise<RollUpResult> {
  const counts = await countItems(jobId);
  const status = deriveJobStatus(counts);
  await setJobStatus(jobId, status);
  return { status, counts };
}

/** The `completed` audit row's count columns. */
export interface AuditCounts {
  resolvedCount: number;
  skippedCount: number;
  failedCount: number;
  sentCount: number;
}

/**
 * Maps item counts to the `completed` audit row's count columns.
 *
 * `resolvedCount` = `resolved` + `submitted` (voice items end at `submitted`).
 * `skippedCount` = `skipped_not_owned` + `skipped_no_contact` + `duplicate_active`.
 * `sentCount` = `sent`.
 *
 * @param counts - The job's item-status tally (`countItems`/`rollUpStatus`).
 * @returns The four count fields for `CompletedAuditInput`.
 */
export function toAuditCounts(counts: JobStatusCounts): AuditCounts {
  return {
    resolvedCount: counts.resolved + counts.submitted,
    skippedCount: counts.skipped_not_owned + counts.skipped_no_contact + counts.duplicate_active,
    failedCount: counts.failed,
    sentCount: counts.sent,
  };
}

/**
 * Marks the job's notification as sent, so a retry does not send it again.
 *
 * @param jobId - The job whose notification was delivered.
 */
export async function setNotifiedAt(jobId: string): Promise<void> {
  await getDb()
    .update(campaignJob)
    .set({ notifiedAt: new Date(), updatedAt: new Date() })
    .where(eq(campaignJob.id, jobId));
}

/**
 * Marks every item still `pending` on a job as `failed`.
 *
 * Used when a job has no retries left, so the counts cover all items.
 *
 * @param jobId - The job that ran out of attempts.
 * @param errorReason - Reason recorded on each item.
 */
export async function failPendingItems(jobId: string, errorReason: string): Promise<void> {
  await getDb()
    .update(campaignJobItem)
    .set({ status: 'failed', errorReason, updatedAt: new Date() })
    .where(and(eq(campaignJobItem.jobId, jobId), eq(campaignJobItem.status, 'pending')));
}

/** Ids of `processing` jobs whose `last_progress_at` is older than the cutoff. */
export async function claimStalledJobs(olderThanSeconds: number): Promise<string[]> {
  const rows = await getDb()
    .select({ id: campaignJob.id })
    .from(campaignJob)
    .where(
      and(
        eq(campaignJob.status, 'processing'),
        lt(campaignJob.lastProgressAt, sql`now() - make_interval(secs => ${olderThanSeconds})`),
      ),
    );
  return rows.map((r) => r.id);
}
