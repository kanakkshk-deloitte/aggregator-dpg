/**
 * Campaign job store contract.
 *
 * Persistence port for campaign async jobs: a `campaign_job` row plus one
 * `campaign_job_item` row per target item. Every campaign channel shares this
 * store. Job roll-up status is derived from item counts, not stored counters.
 *
 * Consumers import only this module (`./interface`) and `./testing`; the API
 * routes resolve a concrete impl via `./index`, the worker via its own client.
 *
 * @module @aggregator-dpg/api
 */

export type CampaignChannel = 'export' | 'email' | 'voice';

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

/** Item statuses that mean the channel acted successfully on the item. */
export const SUCCESS_ITEM_STATUSES: readonly CampaignJobItemStatus[] = [
  'resolved',
  'submitted',
  'sent',
];

/**
 * Item statuses that are neither success nor failure: the item was not acted
 * on. Skips never make a job `partial`.
 */
export const SKIPPED_ITEM_STATUSES: readonly CampaignJobItemStatus[] = [
  'skipped_not_owned',
  'skipped_no_contact',
  'duplicate_active',
];

/**
 * Statuses a channel handler must never act on again when a job retries.
 *
 * `resolved` is not included: it is an intermediate step for email and voice
 * (resolve, then send or submit). `submitted` and `sent` mean an external
 * side effect already happened. Re-resolving an export item on retry is harmless.
 */
export const TERMINAL_ITEM_STATUSES: readonly CampaignJobItemStatus[] = [
  'submitted',
  'sent',
  ...SKIPPED_ITEM_STATUSES,
  'failed',
];

/**
 * Renders {@link TERMINAL_ITEM_STATUSES} for a SQL `NOT IN (...)` predicate.
 * Values are a fixed enum, never user input.
 *
 * @returns e.g. `'submitted','sent','skipped_not_owned',…`
 */
export function terminalItemStatusSqlList(): string {
  return TERMINAL_ITEM_STATUSES.map((s) => `'${s}'`).join(',');
}

/** Statuses that keep an item inside the active-dedup predicate. */
export const ACTIVE_DEDUP_ITEM_STATUSES: readonly CampaignJobItemStatus[] = [
  'pending',
  'resolved',
  'submitted',
];

/** Job statuses that count against a tenant's active-job cap. */
export const ACTIVE_JOB_STATUSES: readonly CampaignJobStatus[] = ['queued', 'processing'];

/** Job statuses a job can no longer move out of. */
export const TERMINAL_JOB_STATUSES: readonly CampaignJobStatus[] = [
  'partial',
  'completed',
  'failed',
];

/** A single free-form metadata pair; stored verbatim from the request envelope. */
export interface CampaignMetadataPair {
  key: string;
  value: string;
}

/** Item to enqueue on a job. `action` is NULL for export (no per-item action). */
export interface CreateJobItemInput {
  itemId: string;
  action: string | null;
}

export interface CreateJobInput {
  aggregatorId: string;
  signalstackOrgId: string;
  channel: CampaignChannel;
  metadata: CampaignMetadataPair[];
  content: Record<string, unknown>;
  requestedBy: string;
  requestId?: string;
  /** Request idempotency key — a replay returns the original job. */
  idempotencyKey?: string;
  items: CreateJobItemInput[];
}

/** Minimal job identity returned by {@link CampaignJobStoreBase.createJob}. */
export interface JobRecord {
  id: string;
  channel: CampaignChannel;
  status: CampaignJobStatus;
  signalstackOrgId: string;
}

/** Derived item-status tally for a job. `total` is the sum of all status counts. */
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

export interface JobItemView {
  itemId: string;
  action: string | null;
  status: CampaignJobItemStatus;
  /** External id this item produced (voice: Raya call id; email: message id). */
  providerRef: string | null;
  /**
   * The provider batch this item was submitted under (voice: the Raya batch
   * id). Stored in the `raya_batch_id` column.
   */
  providerBatchRef: string | null;
  /** Why the item was skipped, when `status` is one of the skip terminals. */
  skipReason: string | null;
  errorReason: string | null;
}

/** Tenant-facing projection of a job (list + detail endpoints). */
export interface JobView {
  id: string;
  channel: CampaignChannel;
  status: CampaignJobStatus;
  metadata: CampaignMetadataPair[];
  content: Record<string, unknown>;
  errorReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  counts: JobStatusCounts;
  /** Raw provider response captured for the campaign manager (voice: Raya create+start payload); `unknown` already includes `null`. */
  providerResponse: unknown;
}

/** Unscoped projection the worker loads to process a job (no tenant filter — the jobId comes from the trusted queue). */
export interface ProcessingJobView {
  id: string;
  channel: CampaignChannel;
  status: CampaignJobStatus;
  signalstackOrgId: string;
  metadata: CampaignMetadataPair[];
  content: Record<string, unknown>;
  requestedBy: string;
  requestId: string | null;
  /** Set once the channel's user-visible notification was sent. */
  notifiedAt: Date | null;
  items: JobItemView[];
}

export interface ListJobsOptions {
  channel?: CampaignChannel;
  limit?: number;
  cursor?: string | null;
}

export interface ListJobsResult {
  jobs: JobView[];
  nextCursor: string | null;
}

export type StoreError =
  { code: 'NOT_FOUND'; message: string } | { code: 'DB_UNAVAILABLE'; message: string };

export type StoreResult<T> = { ok: true; value: T } | { ok: false; error: StoreError };

/**
 * Rolls up the job status from item counts. Shared by every store.
 *
 * @param counts - The job's item-status tally.
 * @returns `processing` while any item is pending; otherwise `completed` (no
 *   failures, or no items), `failed` (no successes), or `partial` (a mix).
 */
export function deriveJobStatus(counts: JobStatusCounts): CampaignJobStatus {
  if (counts.pending > 0) return 'processing';
  if (counts.total === 0) return 'completed';
  const succeeded = counts.resolved + counts.submitted + counts.sent;
  // Skips are not failures. A job with every item skipped is `completed`;
  // callers tell it apart by `counts`.
  if (counts.failed === 0) return 'completed';
  if (succeeded === 0) return 'failed';
  return 'partial';
}

export abstract class CampaignJobStoreBase {
  /**
   * Creates a job and its item rows in one transaction.
   *
   * Idempotent on `idempotencyKey`: a replay returns the original job with
   * `created: false`. An item with a non-null `action` that is already active
   * for the same `(itemId, action)` in any job is inserted as
   * `duplicate_active`. Items with a null `action` (export) are never deduplicated.
   */
  abstract createJob(
    input: CreateJobInput,
  ): Promise<StoreResult<{ job: JobRecord; created: boolean }>>;

  /**
   * Count a tenant's active (queued|processing) jobs — for the per-org cap.
   *
   * @param channel - Count only this channel (the cap is per channel). Omit to count all.
   */
  abstract countActiveJobs(
    signalstackOrgId: string,
    channel?: CampaignChannel,
  ): Promise<StoreResult<number>>;

  /** Tenant-scoped job detail (with derived counts); null when absent/not owned. */
  abstract getJob(jobId: string, signalstackOrgId: string): Promise<StoreResult<JobView | null>>;

  /** Tenant-scoped item list; null when the job is absent/not owned. */
  abstract getJobItems(
    jobId: string,
    signalstackOrgId: string,
  ): Promise<StoreResult<JobItemView[] | null>>;

  /** Tenant-scoped, newest-first, cursor-paginated job list. */
  abstract listJobs(
    signalstackOrgId: string,
    options: ListJobsOptions,
  ): Promise<StoreResult<ListJobsResult>>;

  /** Unscoped load for the worker (jobId is trusted — it came off the queue). */
  abstract getJobForProcessing(jobId: string): Promise<StoreResult<ProcessingJobView | null>>;

  /** Derived item-status tally for a job. */
  abstract countItems(jobId: string): Promise<StoreResult<JobStatusCounts>>;

  /**
   * Sets an item's status. Forward-only: an item already in a terminal status
   * is not overwritten (a retried job re-processes only still-pending items).
   *
   * @param reason - Free-text cause. Stored in `skip_reason` when `status` is a
   *   skip terminal, otherwise in `error_reason`.
   * @param providerRef - External id the channel produced for this item (voice:
   *   Raya call id; email: message id). Ignored when absent.
   */
  abstract markItem(
    jobId: string,
    itemId: string,
    status: CampaignJobItemStatus,
    reason?: string,
    providerRef?: string,
  ): Promise<StoreResult<void>>;

  /**
   * Records that an item was submitted to the voice provider. Sets `status`
   * to `submitted`, stamps `providerBatchRef`, and optionally `providerRef`.
   * Forward-only: a no-op when the item is already in a terminal status (the
   * same retry guard as {@link markItem}).
   *
   * @param args.providerBatchRef - The provider batch id this item was
   *   submitted under (voice: the Raya batch id).
   * @param args.providerRef - External id the submission produced, when the
   *   provider returns one synchronously. Omitted values leave the column
   *   untouched.
   */
  abstract markSubmitted(
    jobId: string,
    itemId: string,
    args: { providerBatchRef: string; providerRef?: string },
  ): Promise<StoreResult<void>>;

  /**
   * Writes the raw provider response captured for a job (voice: the Raya
   * create+start payload), so the campaign manager can render it verbatim.
   *
   * @param response - Arbitrary provider payload, stored as-is.
   */
  abstract setProviderResponse(jobId: string, response: unknown): Promise<StoreResult<void>>;

  /** Stamps `last_progress_at = now()` (watchdog heartbeat). */
  abstract heartbeat(jobId: string): Promise<StoreResult<void>>;

  /** Sets the job's roll-up status (and optional error reason). */
  abstract setJobStatus(
    jobId: string,
    status: CampaignJobStatus,
    errorReason?: string,
  ): Promise<StoreResult<void>>;

  /** Ids of `processing` jobs whose `last_progress_at` is older than the cutoff. */
  abstract claimStalledJobs(olderThanSeconds: number): Promise<StoreResult<string[]>>;

  /**
   * Derives and persists the job's roll-up status from its item counts.
   *
   * @param jobId - The job to roll up.
   * @returns The derived {@link CampaignJobStatus} that was persisted.
   */
  async rollUpStatus(jobId: string): Promise<StoreResult<CampaignJobStatus>> {
    const counts = await this.countItems(jobId);
    if (!counts.ok) return counts;
    const status = deriveJobStatus(counts.value);
    const set = await this.setJobStatus(jobId, status);
    if (!set.ok) return set;
    return { ok: true, value: status };
  }
}
