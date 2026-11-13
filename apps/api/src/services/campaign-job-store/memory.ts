/**
 * In-memory campaign job store — the `./testing` fake for unit tests and dev.
 *
 * Implements the same {@link CampaignJobStoreBase} contract as the Postgres
 * store. Not durable. Lists are ordered by a sequence number, so "newest
 * first" is deterministic in tests.
 *
 * @module @aggregator-dpg/api
 */
import { randomUUID } from 'node:crypto';
import {
  ACTIVE_DEDUP_ITEM_STATUSES,
  ACTIVE_JOB_STATUSES,
  SKIPPED_ITEM_STATUSES,
  TERMINAL_ITEM_STATUSES,
  CampaignJobStoreBase,
  type CampaignChannel,
  type CampaignJobItemStatus,
  type CampaignJobStatus,
  type CreateJobInput,
  type JobItemView,
  type JobRecord,
  type JobStatusCounts,
  type JobView,
  type ListJobsOptions,
  type ListJobsResult,
  type ProcessingJobView,
  type StoreResult,
} from './interface.js';

interface JobRow {
  id: string;
  seq: number;
  aggregatorId: string;
  signalstackOrgId: string;
  channel: JobRecord['channel'];
  status: CampaignJobStatus;
  idempotencyKey: string | null;
  metadata: CreateJobInput['metadata'];
  content: Record<string, unknown>;
  requestedBy: string;
  requestId: string | null;
  errorReason: string | null;
  lastProgressAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  providerResponse: unknown;
}

interface ItemRow {
  itemId: string;
  action: string | null;
  status: CampaignJobItemStatus;
  providerRef: string | null;
  providerBatchRef: string | null;
  skipReason: string | null;
  errorReason: string | null;
}

const TERMINAL_ITEM = new Set<CampaignJobItemStatus>(TERMINAL_ITEM_STATUSES);

export class InMemoryCampaignJobStore extends CampaignJobStoreBase {
  private readonly jobs = new Map<string, JobRow>();
  private readonly items = new Map<string, ItemRow[]>();
  private readonly byIdempotencyKey = new Map<string, string>();
  private seq = 0;

  async createJob(
    input: CreateJobInput,
  ): Promise<StoreResult<{ job: JobRecord; created: boolean }>> {
    // Idempotency is per org: one org's key must never resolve another org's job.
    const idemKey = input.idempotencyKey
      ? `${input.signalstackOrgId}\u0000${input.idempotencyKey}`
      : null;
    if (idemKey) {
      const existingId = this.byIdempotencyKey.get(idemKey);
      if (existingId) {
        const existing = this.jobs.get(existingId)!;
        return { ok: true, value: { job: this.toRecord(existing), created: false } };
      }
    }
    const id = randomUUID();
    const now = new Date();
    const row: JobRow = {
      id,
      seq: ++this.seq,
      aggregatorId: input.aggregatorId,
      signalstackOrgId: input.signalstackOrgId,
      channel: input.channel,
      status: 'queued',
      idempotencyKey: input.idempotencyKey ?? null,
      metadata: input.metadata,
      content: input.content,
      requestedBy: input.requestedBy,
      requestId: input.requestId ?? null,
      errorReason: null,
      lastProgressAt: null,
      createdAt: now,
      updatedAt: now,
      providerResponse: null,
    };
    this.jobs.set(id, row);
    const dupIds = this.activeDedupIds(input.items);
    this.items.set(
      id,
      input.items.map((i) => ({
        itemId: i.itemId,
        action: i.action,
        status: (i.action !== null && dupIds.has(i.itemId)
          ? 'duplicate_active'
          : 'pending') as CampaignJobItemStatus,
        providerRef: null,
        providerBatchRef: null,
        skipReason: null,
        errorReason: null,
      })),
    );
    if (idemKey) this.byIdempotencyKey.set(idemKey, id);
    return { ok: true, value: { job: this.toRecord(row), created: true } };
  }

  /**
   * Returns item ids in the batch already active in any job for the same
   * `(itemId, action)`. Matches the Postgres partial unique index; null-action
   * items are never included.
   */
  private activeDedupIds(candidates: CreateJobInput['items']): Set<string> {
    const dup = new Set<string>();
    const pairs = candidates.filter((i) => i.action !== null);
    if (pairs.length === 0) return dup;
    for (const rows of this.items.values()) {
      for (const row of rows) {
        if (row.action === null) continue;
        if (!ACTIVE_DEDUP_ITEM_STATUSES.includes(row.status)) continue;
        if (pairs.some((p) => p.itemId === row.itemId && p.action === row.action)) {
          dup.add(row.itemId);
        }
      }
    }
    return dup;
  }

  async countActiveJobs(
    signalstackOrgId: string,
    channel?: CampaignChannel,
  ): Promise<StoreResult<number>> {
    let n = 0;
    for (const job of this.jobs.values()) {
      if (
        job.signalstackOrgId === signalstackOrgId &&
        ACTIVE_JOB_STATUSES.includes(job.status) &&
        (channel === undefined || job.channel === channel)
      ) {
        n++;
      }
    }
    return { ok: true, value: n };
  }

  async getJob(jobId: string, signalstackOrgId: string): Promise<StoreResult<JobView | null>> {
    const job = this.jobs.get(jobId);
    if (job?.signalstackOrgId !== signalstackOrgId) return { ok: true, value: null };
    return { ok: true, value: this.toView(job) };
  }

  async getJobItems(
    jobId: string,
    signalstackOrgId: string,
  ): Promise<StoreResult<JobItemView[] | null>> {
    const job = this.jobs.get(jobId);
    if (job?.signalstackOrgId !== signalstackOrgId) return { ok: true, value: null };
    return { ok: true, value: (this.items.get(jobId) ?? []).map((i) => ({ ...i })) };
  }

  async listJobs(
    signalstackOrgId: string,
    options: ListJobsOptions,
  ): Promise<StoreResult<ListJobsResult>> {
    const limit = options.limit ?? 20;
    const cursorSeq = options.cursor ? Number(options.cursor) : Number.POSITIVE_INFINITY;
    const rows = [...this.jobs.values()]
      .filter((j) => j.signalstackOrgId === signalstackOrgId)
      .filter((j) => (options.channel ? j.channel === options.channel : true))
      .filter((j) => j.seq < cursorSeq)
      .sort((a, b) => b.seq - a.seq);
    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? String(page.at(-1)!.seq) : null;
    return { ok: true, value: { jobs: page.map((j) => this.toView(j)), nextCursor } };
  }

  async getJobForProcessing(jobId: string): Promise<StoreResult<ProcessingJobView | null>> {
    const job = this.jobs.get(jobId);
    if (!job) return { ok: true, value: null };
    return {
      ok: true,
      value: {
        id: job.id,
        channel: job.channel,
        status: job.status,
        signalstackOrgId: job.signalstackOrgId,
        metadata: job.metadata,
        content: job.content,
        requestedBy: job.requestedBy,
        requestId: job.requestId,
        notifiedAt: null,
        items: (this.items.get(jobId) ?? []).map((i) => ({ ...i })),
      },
    };
  }

  async countItems(jobId: string): Promise<StoreResult<JobStatusCounts>> {
    return { ok: true, value: tally(this.items.get(jobId) ?? []) };
  }

  async markItem(
    jobId: string,
    itemId: string,
    status: CampaignJobItemStatus,
    reason?: string,
    providerRef?: string,
  ): Promise<StoreResult<void>> {
    const rows = this.items.get(jobId);
    const item = rows?.find((i) => i.itemId === itemId);
    if (!item) return { ok: false, error: { code: 'NOT_FOUND', message: 'item not found' } };
    // Forward-only: don't overwrite a terminal status.
    if (!TERMINAL_ITEM.has(item.status)) {
      const isSkip = SKIPPED_ITEM_STATUSES.includes(status);
      item.status = status;
      item.skipReason = isSkip ? (reason ?? null) : null;
      item.errorReason = isSkip ? null : (reason ?? null);
      if (providerRef !== undefined) item.providerRef = providerRef;
      this.touch(jobId);
    }
    return { ok: true, value: undefined };
  }

  async markSubmitted(
    jobId: string,
    itemId: string,
    args: { providerBatchRef: string; providerRef?: string },
  ): Promise<StoreResult<void>> {
    const rows = this.items.get(jobId);
    const item = rows?.find((i) => i.itemId === itemId);
    if (!item) return { ok: false, error: { code: 'NOT_FOUND', message: 'item not found' } };
    // Forward-only: don't overwrite a terminal status.
    if (!TERMINAL_ITEM.has(item.status)) {
      item.status = 'submitted';
      item.providerBatchRef = args.providerBatchRef;
      if (args.providerRef !== undefined) item.providerRef = args.providerRef;
      this.touch(jobId);
    }
    return { ok: true, value: undefined };
  }

  async setProviderResponse(jobId: string, response: unknown): Promise<StoreResult<void>> {
    const job = this.jobs.get(jobId);
    if (!job) return { ok: false, error: { code: 'NOT_FOUND', message: 'job not found' } };
    job.providerResponse = response;
    this.touch(jobId);
    return { ok: true, value: undefined };
  }

  async heartbeat(jobId: string): Promise<StoreResult<void>> {
    const job = this.jobs.get(jobId);
    if (!job) return { ok: false, error: { code: 'NOT_FOUND', message: 'job not found' } };
    job.lastProgressAt = new Date();
    return { ok: true, value: undefined };
  }

  async setJobStatus(
    jobId: string,
    status: CampaignJobStatus,
    errorReason?: string,
  ): Promise<StoreResult<void>> {
    const job = this.jobs.get(jobId);
    if (!job) return { ok: false, error: { code: 'NOT_FOUND', message: 'job not found' } };
    job.status = status;
    if (errorReason !== undefined) job.errorReason = errorReason;
    this.touch(jobId);
    return { ok: true, value: undefined };
  }

  async claimStalledJobs(olderThanSeconds: number): Promise<StoreResult<string[]>> {
    const cutoff = Date.now() - olderThanSeconds * 1000;
    const ids = [...this.jobs.values()]
      .filter((j) => j.status === 'processing')
      .filter((j) => j.lastProgressAt !== null && j.lastProgressAt.getTime() < cutoff)
      .map((j) => j.id);
    return { ok: true, value: ids };
  }

  private touch(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (job) job.updatedAt = new Date();
  }

  private toRecord(row: JobRow): JobRecord {
    return {
      id: row.id,
      channel: row.channel,
      status: row.status,
      signalstackOrgId: row.signalstackOrgId,
    };
  }

  private toView(row: JobRow): JobView {
    return {
      id: row.id,
      channel: row.channel,
      status: row.status,
      metadata: row.metadata,
      content: row.content,
      errorReason: row.errorReason,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      counts: tally(this.items.get(row.id) ?? []),
      providerResponse: row.providerResponse,
    };
  }
}

function tally(items: ItemRow[]): JobStatusCounts {
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
  for (const i of items) {
    counts.total++;
    counts[i.status]++;
  }
  return counts;
}
