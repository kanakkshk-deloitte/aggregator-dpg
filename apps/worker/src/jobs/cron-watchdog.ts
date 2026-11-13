/**
 * Stuck-job watchdog and retention sweeper for the worker app.
 *
 * Runs hourly:
 *   - watchdog: pending > 24h fails as `upload_abandoned`; in-flight with no
 *     progress for 30 min fails as `processing_stuck`.
 *   - campaign: a `processing` job with a stale heartbeat fails as `stalled`,
 *     its pending items are failed, and a `completed` audit row is written.
 *   - retention: bulk_uploads and link_submissions older than RETENTION_DAYS
 *     are deleted. Onboarding rollups are kept.
 *
 * S3 objects are removed by bucket lifecycle rules, not by the worker.
 */

import { and, eq, inArray, isNotNull, lt } from 'drizzle-orm';
import { bulkRedisKeys } from '@aggregator-dpg/queue';
import { getDb, schema } from '../db.js';
import { getRedis } from '../services/redis.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  countItems,
  failPendingItems,
  toAuditCounts,
  type CampaignChannel,
} from '../services/campaign-job-client.js';
import {
  getCampaignAuditWriter,
  safeAudit,
  type SafeAuditLogger,
} from '../services/campaign-audit.js';
import { exportAuditExtras } from '../services/campaign-process/index.js';

const RETENTION_DAYS = 90;
const STUCK_INFLIGHT_MINUTES = 30;
const ABANDONED_PENDING_HOURS = 24;
const INFLIGHT_STATUSES = ['file_validating', 'row_processing', 'finalising'] as const;

export interface WatchdogOutcome {
  abandoned: number;
  stuck: number;
  campaignStalled: number;
  bulkPurged: number;
  submissionsPurged: number;
}

export async function runWatchdog(): Promise<WatchdogOutcome> {
  const log = logger.child({ operation: 'cron.watchdog' });
  const start = Date.now();

  const abandonedAt = new Date(Date.now() - ABANDONED_PENDING_HOURS * 60 * 60 * 1000);
  const stuckAt = new Date(Date.now() - STUCK_INFLIGHT_MINUTES * 60 * 1000);
  const retentionCutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const abandoned = await getDb()
    .update(schema.bulkUploads)
    .set({ status: 'failed', statusReason: 'upload_abandoned', updatedAt: new Date() })
    .where(
      and(eq(schema.bulkUploads.status, 'pending'), lt(schema.bulkUploads.createdAt, abandonedAt)),
    )
    .returning({ id: schema.bulkUploads.id });

  const stuck = await getDb()
    .update(schema.bulkUploads)
    .set({ status: 'failed', statusReason: 'processing_stuck', updatedAt: new Date() })
    .where(
      and(
        inArray(schema.bulkUploads.status, [...INFLIGHT_STATUSES]),
        isNotNull(schema.bulkUploads.lastProgressAt),
        lt(schema.bulkUploads.lastProgressAt, stuckAt),
      ),
    )
    .returning({ id: schema.bulkUploads.id });

  // Fail `processing` campaign jobs with a stale heartbeat as `stalled`.
  // Their pending items are failed in `auditStalledJob`.
  const campaignStalledAt = new Date(Date.now() - config.CAMPAIGN_STALL_SECONDS * 1000);
  const campaignStalled = await getDb()
    .update(schema.campaignJob)
    .set({ status: 'failed', errorReason: 'stalled', updatedAt: new Date() })
    .where(
      and(
        eq(schema.campaignJob.status, 'processing'),
        isNotNull(schema.campaignJob.lastProgressAt),
        lt(schema.campaignJob.lastProgressAt, campaignStalledAt),
      ),
    )
    .returning({
      id: schema.campaignJob.id,
      // Fields the `completed` audit row needs.
      channel: schema.campaignJob.channel,
      signalstackOrgId: schema.campaignJob.signalstackOrgId,
      requestedBy: schema.campaignJob.requestedBy,
    });

  // Every terminal job gets a `completed` audit row. Best-effort per job: one
  // failure must not skip the rest or the retention sweep.
  for (const stalledJob of campaignStalled) {
    await auditStalledJob(stalledJob, log);
  }

  // Delete Redis keys (including PII in `:lines` and `:errors`) for uploads
  // just failed. The key TTL is the backstop.
  const terminalIds = [...abandoned, ...stuck].map((r) => r.id);
  let redisKeysPurged = 0;
  if (terminalIds.length > 0) {
    const keys = terminalIds.flatMap((id) => bulkRedisKeys(id));
    redisKeysPurged = await getRedis().del(...keys);
  }

  // Retention: delete terminal bulk uploads past the cutoff. Onboarding rollups are kept.
  const bulkPurged = await getDb()
    .delete(schema.bulkUploads)
    .where(
      and(
        inArray(schema.bulkUploads.status, ['completed', 'failed', 'file_failed']),
        lt(schema.bulkUploads.createdAt, retentionCutoff),
      ),
    )
    .returning({ id: schema.bulkUploads.id });

  const submissionsPurged = await getDb()
    .delete(schema.linkSubmissions)
    .where(
      and(
        isNotNull(schema.linkSubmissions.rolledUpAt),
        lt(schema.linkSubmissions.createdAt, retentionCutoff),
      ),
    )
    .returning({ id: schema.linkSubmissions.id });

  log.info({
    status: 'success',
    latency_ms: Date.now() - start,
    abandoned: abandoned.length,
    stuck: stuck.length,
    campaign_stalled: campaignStalled.length,
    redis_keys_purged: redisKeysPurged,
    bulk_purged: bulkPurged.length,
    submissions_purged: submissionsPurged.length,
  });

  return {
    abandoned: abandoned.length,
    stuck: stuck.length,
    campaignStalled: campaignStalled.length,
    bulkPurged: bulkPurged.length,
    submissionsPurged: submissionsPurged.length,
  };
}

/** Shape of one row from the campaign-stall sweep's `.returning()`. */
interface StalledCampaignJob {
  id: string;
  channel: CampaignChannel;
  signalstackOrgId: string;
  requestedBy: string;
}

/**
 * Marks a stalled job's pending items as failed and writes its `completed` audit row.
 *
 * Never throws. Steps:
 * 1. Fail items still `pending`. This runs before counting, since `pending`
 *    maps to no audit column. On error, the audit row is still written.
 * 2. Count items. On error, the audit row is written without counts.
 * 3. Write the audit row through {@link safeAudit}.
 *
 * Export-channel fields come from `exportAuditExtras`, shared with the worker's
 * own terminal paths.
 *
 * @param stalledJob - One row from the campaign-stall sweep's `.returning()`.
 * @param log - The watchdog's structured logger.
 */
async function auditStalledJob(
  stalledJob: StalledCampaignJob,
  log: SafeAuditLogger,
): Promise<void> {
  try {
    await failPendingItems(stalledJob.id, 'stalled');
  } catch (cause) {
    log.error({
      operation: 'campaignAudit.completed',
      status: 'failure',
      job_id: stalledJob.id,
      channel: stalledJob.channel,
      reason: 'fail_pending_items_failed',
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }

  let counts: Awaited<ReturnType<typeof countItems>> | undefined;
  try {
    counts = await countItems(stalledJob.id);
  } catch (cause) {
    log.error({
      operation: 'campaignAudit.completed',
      status: 'failure',
      job_id: stalledJob.id,
      channel: stalledJob.channel,
      reason: 'counts_unavailable',
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }

  await safeAudit(
    () =>
      getCampaignAuditWriter().recordCompleted({
        correlationId: stalledJob.id,
        channel: stalledJob.channel,
        actorSignalstackOrgId: stalledJob.signalstackOrgId,
        outcome: 'failed',
        errorCode: 'stalled',
        completedAt: new Date(),
        ...(counts ? toAuditCounts(counts) : {}),
        ...exportAuditExtras(stalledJob, {
          recipientMode: config.CAMPAIGN_EXPORT_RECIPIENT,
          ...(config.EXPORT_NETWORK_ADMIN_EMAIL
            ? { networkAdminEmail: config.EXPORT_NETWORK_ADMIN_EMAIL }
            : {}),
        }),
      }),
    log,
    { operation: 'campaignAudit.completed', job_id: stalledJob.id, channel: stalledJob.channel },
  );
}
