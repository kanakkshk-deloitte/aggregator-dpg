/**
 * Stuck-job watchdog (slice 23) and retention sweeper (slice 22).
 *
 * Runs hourly. Two passes:
 *   - watchdog: pending > 24h → failed:upload_abandoned;
 *               in-flight > 30 min stalled → failed:processing_stuck.
 *   - retention: bulk_uploads + link_submissions older than RETENTION_DAYS
 *               are deleted. Onboarding rollups are retained forever per
 *               design — no sweep there.
 *
 * S3 lifecycle (raw CSVs + errors.csv) is configured externally on the
 * bucket; the worker does not delete S3 objects.
 */

import { and, eq, inArray, isNotNull, lt } from 'drizzle-orm';
import { bulkRedisKeys } from '@aggregator-dpg/queue';
import { getDb, schema } from '../db.js';
import { getRedis } from '../services/redis.js';
import { logger } from '../logger.js';

const RETENTION_DAYS = 90;
const STUCK_INFLIGHT_MINUTES = 30;
const ABANDONED_PENDING_HOURS = 24;
const INFLIGHT_STATUSES = ['file_validating', 'row_processing', 'finalising'] as const;

export interface WatchdogOutcome {
  abandoned: number;
  stuck: number;
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

  // Actively purge the Redis working set (incl. the PII-bearing `:lines` and
  // `:errors` keys) for uploads we just marked failed — the happy-path DEL in
  // bulk-finalise never runs for these. The per-key TTL is the backstop if this
  // pass is missed; this makes cleanup immediate. `abandoned` uploads are still
  // `pending` (usually no keys written yet) — DEL is a harmless no-op there.
  const terminalIds = [...abandoned, ...stuck].map((r) => r.id);
  let redisKeysPurged = 0;
  if (terminalIds.length > 0) {
    const keys = terminalIds.flatMap((id) => bulkRedisKeys(id));
    redisKeysPurged = await getRedis().del(...keys);
  }

  // Retention: terminal-status bulk uploads beyond cutoff. Keep onboarding
  // rollups untouched (forever per design); cascade FK from
  // link_submission.participant_id is set null on participant delete, but
  // we don't sweep participants.
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
    redis_keys_purged: redisKeysPurged,
    bulk_purged: bulkPurged.length,
    submissions_purged: submissionsPurged.length,
  });

  return {
    abandoned: abandoned.length,
    stuck: stuck.length,
    bulkPurged: bulkPurged.length,
    submissionsPurged: submissionsPurged.length,
  };
}
