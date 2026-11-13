/**
 * Postgres adapter for the campaign job store.
 *
 * Wraps Drizzle queries against `campaign_job` / `campaign_job_item`. A job and
 * its items are created in one transaction. Status counts come from
 * `COUNT(*) ... GROUP BY status`. All errors map to the `StoreError` codes.
 *
 * @module @aggregator-dpg/api
 */
import { and, count, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { logger } from '../../logger.js';
import { campaignJob, campaignJobItem } from '../../db/schema.js';
import { getDb } from '../../db/client.js';
import {
  ACTIVE_DEDUP_ITEM_STATUSES,
  ACTIVE_JOB_STATUSES,
  SKIPPED_ITEM_STATUSES,
  TERMINAL_ITEM_STATUSES,
  terminalItemStatusSqlList,
  TERMINAL_JOB_STATUSES,
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
  type StoreError,
  type StoreResult,
} from './interface.js';

/** Matches the `campaign_job_item_active_dedup` partial unique index predicate. */
const ACTIVE_DEDUP_WHERE = sql`status IN ('pending','resolved','submitted') AND action IS NOT NULL`;

const CURSOR_SEP = '__';

type JobRow = typeof campaignJob.$inferSelect;

/** The transaction handle type `getDb().transaction(async (tx) => ...)` passes. */
type CampaignTx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

export class PostgresCampaignJobStore extends CampaignJobStoreBase {
  async createJob(
    input: CreateJobInput,
  ): Promise<StoreResult<{ job: JobRecord; created: boolean }>> {
    const start = Date.now();
    try {
      const result = await getDb().transaction(async (tx) => {
        const values = {
          userId: input.aggregatorId,
          signalstackOrgId: input.signalstackOrgId,
          channel: input.channel,
          metadata: input.metadata,
          content: input.content,
          requestedBy: input.requestedBy,
          requestId: input.requestId ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
        };
        const insertedRows = input.idempotencyKey
          ? await tx
              .insert(campaignJob)
              .values(values)
              .onConflictDoNothing({
                // Must match the partial unique index, which is per tenant.
                target: [campaignJob.signalstackOrgId, campaignJob.idempotencyKey],
                where: sql`idempotency_key IS NOT NULL`,
              })
              .returning()
          : await tx.insert(campaignJob).values(values).returning();

        let row = insertedRows[0];
        let created = true;
        if (!row) {
          // Idempotency-key conflict — return the original job, add no items.
          created = false;
          // Scoped to the org, so another org's key never returns its job.
          const existing = await tx
            .select()
            .from(campaignJob)
            .where(
              and(
                eq(campaignJob.signalstackOrgId, input.signalstackOrgId),
                eq(campaignJob.idempotencyKey, input.idempotencyKey!),
              ),
            )
            .limit(1);
          row = existing[0];
        }
        if (!row) throw new Error('campaign job insert returned no row');

        if (created && input.items.length > 0) {
          await this.insertJobItems(tx, row.id, input.channel, input.items);
        }
        return { row, created };
      });

      logger.info({
        operation: 'campaignJobStore.createJob',
        status: 'success',
        latency_ms: Date.now() - start,
        job_id: result.row.id,
        channel: result.row.channel,
        created: result.created,
        items: input.items.length,
      });
      return { ok: true, value: { job: toRecord(result.row), created: result.created } };
    } catch (err) {
      return dbError('createJob', err, start);
    }
  }

  /**
   * Inserts one item row per input inside the caller's transaction.
   *
   * An item with a non-null `action` already active for the same
   * `(itemId, action)` in any job is inserted as `duplicate_active`. A
   * concurrent insert that wins the race is skipped by `ON CONFLICT DO NOTHING`;
   * those items are then inserted as `duplicate_active`, which the index does
   * not cover.
   */
  private async insertJobItems(
    tx: CampaignTx,
    jobId: string,
    channel: CampaignChannel,
    items: CreateJobInput['items'],
  ): Promise<void> {
    const dupIds = await this.activeDedupIds(tx, items);
    const rowFor = (i: CreateJobInput['items'][number], status: CampaignJobItemStatus) => ({
      jobId,
      channel,
      itemId: i.itemId,
      action: i.action,
      status,
    });

    const values = items.map((i) =>
      rowFor(i, i.action !== null && dupIds.has(i.itemId) ? 'duplicate_active' : 'pending'),
    );

    const inserted = await tx
      .insert(campaignJobItem)
      .values(values)
      .onConflictDoNothing({
        target: [campaignJobItem.itemId, campaignJobItem.action],
        where: ACTIVE_DEDUP_WHERE,
      })
      .returning({ itemId: campaignJobItem.itemId });

    const insertedIds = new Set(inserted.map((r) => r.itemId));
    const raced = items.filter(
      (i) => i.action !== null && !dupIds.has(i.itemId) && !insertedIds.has(i.itemId),
    );
    if (raced.length > 0) {
      await tx.insert(campaignJobItem).values(raced.map((i) => rowFor(i, 'duplicate_active')));
    }
  }

  /** Item ids (from the batch) already active elsewhere for the same `(itemId, action)`. */
  private async activeDedupIds(
    tx: CampaignTx,
    items: CreateJobInput['items'],
  ): Promise<Set<string>> {
    const dup = new Set<string>();
    const byAction = new Map<string, string[]>();
    for (const i of items) {
      if (i.action === null) continue;
      const ids = byAction.get(i.action) ?? [];
      ids.push(i.itemId);
      byAction.set(i.action, ids);
    }
    for (const [action, ids] of byAction) {
      const rows = await tx
        .select({ itemId: campaignJobItem.itemId })
        .from(campaignJobItem)
        .where(
          and(
            eq(campaignJobItem.action, action),
            inArray(campaignJobItem.itemId, ids),
            inArray(campaignJobItem.status, [...ACTIVE_DEDUP_ITEM_STATUSES]),
          ),
        );
      for (const r of rows) dup.add(r.itemId);
    }
    return dup;
  }

  async countActiveJobs(
    signalstackOrgId: string,
    channel?: CampaignChannel,
  ): Promise<StoreResult<number>> {
    const start = Date.now();
    try {
      const rows = await getDb()
        .select({ n: count() })
        .from(campaignJob)
        .where(
          and(
            eq(campaignJob.signalstackOrgId, signalstackOrgId),
            inArray(campaignJob.status, [...ACTIVE_JOB_STATUSES]),
            ...(channel ? [eq(campaignJob.channel, channel)] : []),
          ),
        );
      return { ok: true, value: Number(rows[0]?.n ?? 0) };
    } catch (err) {
      return dbError('countActiveJobs', err, start);
    }
  }

  async getJob(jobId: string, signalstackOrgId: string): Promise<StoreResult<JobView | null>> {
    const start = Date.now();
    try {
      const rows = await getDb()
        .select()
        .from(campaignJob)
        .where(and(eq(campaignJob.id, jobId), eq(campaignJob.signalstackOrgId, signalstackOrgId)))
        .limit(1);
      const row = rows[0];
      if (!row) return { ok: true, value: null };
      const counts = await this.countItems(jobId);
      if (!counts.ok) return counts;
      return { ok: true, value: toView(row, counts.value) };
    } catch (err) {
      return dbError('getJob', err, start);
    }
  }

  async getJobItems(
    jobId: string,
    signalstackOrgId: string,
  ): Promise<StoreResult<JobItemView[] | null>> {
    const start = Date.now();
    try {
      const owner = await getDb()
        .select({ id: campaignJob.id })
        .from(campaignJob)
        .where(and(eq(campaignJob.id, jobId), eq(campaignJob.signalstackOrgId, signalstackOrgId)))
        .limit(1);
      if (!owner[0]) return { ok: true, value: null };
      const rows = await getDb()
        .select()
        .from(campaignJobItem)
        .where(eq(campaignJobItem.jobId, jobId))
        .orderBy(campaignJobItem.createdAt);
      return { ok: true, value: rows.map(toItemView) };
    } catch (err) {
      return dbError('getJobItems', err, start);
    }
  }

  async listJobs(
    signalstackOrgId: string,
    options: ListJobsOptions,
  ): Promise<StoreResult<ListJobsResult>> {
    const start = Date.now();
    const limit = options.limit ?? 20;
    try {
      const conds = [eq(campaignJob.signalstackOrgId, signalstackOrgId)];
      if (options.channel) conds.push(eq(campaignJob.channel, options.channel));
      const cursor = options.cursor ? decodeCursor(options.cursor) : null;
      if (cursor) {
        conds.push(
          sql`(${campaignJob.createdAt}, ${campaignJob.id}) < (${cursor.ts}, ${cursor.id})`,
        );
      }
      const rows = await getDb()
        .select()
        .from(campaignJob)
        .where(and(...conds))
        .orderBy(desc(campaignJob.createdAt), desc(campaignJob.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const countsByJob = await this.countsForJobs(page.map((r) => r.id));
      const jobs = page.map((r) => toView(r, countsByJob.get(r.id) ?? emptyCounts()));
      const last = page.at(-1);
      const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.id) : null;
      return { ok: true, value: { jobs, nextCursor } };
    } catch (err) {
      return dbError('listJobs', err, start);
    }
  }

  async getJobForProcessing(jobId: string): Promise<StoreResult<ProcessingJobView | null>> {
    const start = Date.now();
    try {
      const rows = await getDb()
        .select()
        .from(campaignJob)
        .where(eq(campaignJob.id, jobId))
        .limit(1);
      const row = rows[0];
      if (!row) return { ok: true, value: null };
      const items = await getDb()
        .select()
        .from(campaignJobItem)
        .where(eq(campaignJobItem.jobId, jobId))
        .orderBy(campaignJobItem.createdAt);
      return {
        ok: true,
        value: {
          id: row.id,
          channel: row.channel,
          status: row.status,
          signalstackOrgId: row.signalstackOrgId,
          metadata: row.metadata,
          content: row.content,
          requestedBy: row.requestedBy,
          requestId: row.requestId,
          notifiedAt: row.notifiedAt,
          items: items.map(toItemView),
        },
      };
    } catch (err) {
      return dbError('getJobForProcessing', err, start);
    }
  }

  async countItems(jobId: string): Promise<StoreResult<JobStatusCounts>> {
    const start = Date.now();
    try {
      const rows = await getDb()
        .select({ status: campaignJobItem.status, n: count() })
        .from(campaignJobItem)
        .where(eq(campaignJobItem.jobId, jobId))
        .groupBy(campaignJobItem.status);
      const counts = emptyCounts();
      for (const r of rows) {
        const n = Number(r.n);
        counts[r.status] += n;
        counts.total += n;
      }
      return { ok: true, value: counts };
    } catch (err) {
      return dbError('countItems', err, start);
    }
  }

  async markItem(
    jobId: string,
    itemId: string,
    status: CampaignJobItemStatus,
    reason?: string,
    providerRef?: string,
  ): Promise<StoreResult<void>> {
    const start = Date.now();
    try {
      const now = new Date();
      // A skip is not an error: its reason belongs in `skip_reason`.
      const isSkip = SKIPPED_ITEM_STATUSES.includes(status);
      await getDb()
        .update(campaignJobItem)
        .set({
          status,
          skipReason: isSkip ? (reason ?? null) : null,
          errorReason: isSkip ? null : (reason ?? null),
          ...(providerRef !== undefined ? { providerRef } : {}),
          updatedAt: now,
          ...(TERMINAL_ITEM_STATUSES.includes(status) ? { completedAt: now } : {}),
        })
        .where(
          and(
            eq(campaignJobItem.jobId, jobId),
            eq(campaignJobItem.itemId, itemId),
            // Forward-only: skip rows already in a terminal status.
            sql.raw(`"campaign_job_item"."status" NOT IN (${terminalItemStatusSqlList()})`),
          ),
        );
      return { ok: true, value: undefined };
    } catch (err) {
      return dbError('markItem', err, start);
    }
  }

  async markSubmitted(
    jobId: string,
    itemId: string,
    args: { providerBatchRef: string; providerRef?: string },
  ): Promise<StoreResult<void>> {
    const start = Date.now();
    try {
      const now = new Date();
      await getDb()
        .update(campaignJobItem)
        .set({
          status: 'submitted',
          // The `raya_batch_id` column stores `providerBatchRef`.
          rayaBatchId: args.providerBatchRef,
          ...(args.providerRef !== undefined ? { providerRef: args.providerRef } : {}),
          updatedAt: now,
          completedAt: now, // 'submitted' is always a terminal status
        })
        .where(
          and(
            eq(campaignJobItem.jobId, jobId),
            eq(campaignJobItem.itemId, itemId),
            // Forward-only: skip rows already in a terminal status.
            sql.raw(`"campaign_job_item"."status" NOT IN (${terminalItemStatusSqlList()})`),
          ),
        );
      return { ok: true, value: undefined };
    } catch (err) {
      return dbError('markSubmitted', err, start);
    }
  }

  async setProviderResponse(jobId: string, response: unknown): Promise<StoreResult<void>> {
    const start = Date.now();
    try {
      await getDb()
        .update(campaignJob)
        .set({ providerResponse: response, updatedAt: new Date() })
        .where(eq(campaignJob.id, jobId));
      return { ok: true, value: undefined };
    } catch (err) {
      return dbError('setProviderResponse', err, start);
    }
  }

  async heartbeat(jobId: string): Promise<StoreResult<void>> {
    const start = Date.now();
    try {
      await getDb()
        .update(campaignJob)
        .set({ lastProgressAt: new Date() })
        .where(eq(campaignJob.id, jobId));
      return { ok: true, value: undefined };
    } catch (err) {
      return dbError('heartbeat', err, start);
    }
  }

  async setJobStatus(
    jobId: string,
    status: CampaignJobStatus,
    errorReason?: string,
  ): Promise<StoreResult<void>> {
    const start = Date.now();
    try {
      await getDb()
        .update(campaignJob)
        .set({
          status,
          ...(errorReason !== undefined ? { errorReason } : {}),
          updatedAt: new Date(),
          ...(TERMINAL_JOB_STATUSES.includes(status) ? { completedAt: new Date() } : {}),
        })
        .where(eq(campaignJob.id, jobId));
      return { ok: true, value: undefined };
    } catch (err) {
      return dbError('setJobStatus', err, start);
    }
  }

  async claimStalledJobs(olderThanSeconds: number): Promise<StoreResult<string[]>> {
    const start = Date.now();
    try {
      const rows = await getDb()
        .select({ id: campaignJob.id })
        .from(campaignJob)
        .where(
          and(
            eq(campaignJob.status, 'processing'),
            lt(campaignJob.lastProgressAt, sql`now() - make_interval(secs => ${olderThanSeconds})`),
          ),
        );
      return { ok: true, value: rows.map((r) => r.id) };
    } catch (err) {
      return dbError('claimStalledJobs', err, start);
    }
  }

  /** Grouped item-status counts for a set of jobs (one query, no N+1). */
  private async countsForJobs(jobIds: string[]): Promise<Map<string, JobStatusCounts>> {
    const out = new Map<string, JobStatusCounts>();
    if (jobIds.length === 0) return out;
    const rows = await getDb()
      .select({ jobId: campaignJobItem.jobId, status: campaignJobItem.status, n: count() })
      .from(campaignJobItem)
      .where(inArray(campaignJobItem.jobId, jobIds))
      .groupBy(campaignJobItem.jobId, campaignJobItem.status);
    for (const r of rows) {
      const c = out.get(r.jobId) ?? emptyCounts();
      const n = Number(r.n);
      c[r.status] += n;
      c.total += n;
      out.set(r.jobId, c);
    }
    return out;
  }
}

function emptyCounts(): JobStatusCounts {
  return {
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
}

function toRecord(row: JobRow): JobRecord {
  return {
    id: row.id,
    channel: row.channel,
    status: row.status,
    signalstackOrgId: row.signalstackOrgId,
  };
}

function toView(row: JobRow, counts: JobStatusCounts): JobView {
  return {
    id: row.id,
    channel: row.channel,
    status: row.status,
    metadata: row.metadata,
    content: row.content,
    errorReason: row.errorReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    counts,
    providerResponse: row.providerResponse,
  };
}

function toItemView(row: typeof campaignJobItem.$inferSelect): JobItemView {
  return {
    itemId: row.itemId,
    action: row.action,
    status: row.status,
    providerRef: row.providerRef,
    providerBatchRef: row.rayaBatchId,
    skipReason: row.skipReason,
    errorReason: row.errorReason,
  };
}

function encodeCursor(createdAt: Date, id: string): string {
  return `${createdAt.toISOString()}${CURSOR_SEP}${id}`;
}

function decodeCursor(cursor: string): { ts: string; id: string } | null {
  const idx = cursor.indexOf(CURSOR_SEP);
  if (idx < 0) return null;
  return { ts: cursor.slice(0, idx), id: cursor.slice(idx + CURSOR_SEP.length) };
}

function dbError(op: string, err: unknown, start: number): { ok: false; error: StoreError } {
  logger.error({
    operation: `campaignJobStore.${op}`,
    status: 'failure',
    latency_ms: Date.now() - start,
    error: err instanceof Error ? err.message : String(err),
    error_type: err instanceof Error ? err.constructor.name : 'unknown',
  });
  return {
    ok: false,
    error: { code: 'DB_UNAVAILABLE', message: `campaign job store ${op} failed` },
  };
}
