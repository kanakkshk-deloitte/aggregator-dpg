/**
 * Link metrics rollup for the worker app: adds `link_submissions` into `onboarding`.
 *
 * Steps:
 *   1. Select up to BATCH_SIZE submissions with `rolled_up_at IS NULL`.
 *   2. Group by aggregator, link and hour.
 *   3. Upsert each group into `onboarding` (source='link'), adding to the totals.
 *   4. Set `rolled_up_at` on the selected submissions.
 *
 * Steps 3 and 4 are not in one transaction. A crash between them counts those
 * submissions again on the next run.
 */

import { eq, inArray, isNull, sql } from 'drizzle-orm';
import type { LinkMetricsRollupJob } from '@aggregator-dpg/queue';
import { getDb, schema } from '../db.js';
import { logger } from '../logger.js';

const BATCH_SIZE = 1000;

interface BucketKey {
  aggregatorId: string;
  orgSlug: string;
  linkId: string;
  hourBucketIso: string;
}

interface BucketTotals {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  submissionIds: string[];
}

export interface RollupOutcome {
  status: 'rolled_up' | 'idle';
  submissions: number;
  buckets: number;
}

export async function rollupLinkMetrics(_job: LinkMetricsRollupJob): Promise<RollupOutcome> {
  const log = logger.child({ operation: 'linkMetricsRollup' });
  const start = Date.now();

  const rows = await getDb()
    .select({
      id: schema.linkSubmissions.id,
      linkId: schema.linkSubmissions.linkId,
      aggregatorId: schema.linkSubmissions.userId,
      orgSlug: schema.users.signalstackOrgSlug,
      outcome: schema.linkSubmissions.outcome,
      createdAt: schema.linkSubmissions.createdAt,
    })
    .from(schema.linkSubmissions)
    .innerJoin(schema.users, eq(schema.linkSubmissions.userId, schema.users.id))
    .where(isNull(schema.linkSubmissions.rolledUpAt))
    .orderBy(schema.linkSubmissions.createdAt)
    .limit(BATCH_SIZE);

  if (rows.length === 0) {
    log.info({ status: 'idle', latency_ms: Date.now() - start });
    return { status: 'idle', submissions: 0, buckets: 0 };
  }

  // Group by (aggregator, link, hour-bucket).
  const buckets = new Map<string, { key: BucketKey; totals: BucketTotals }>();
  for (const row of rows) {
    const bucketStart = startOfHour(row.createdAt);
    const cacheKey = `${row.aggregatorId}|${row.linkId}|${bucketStart.toISOString()}`;
    let entry = buckets.get(cacheKey);
    if (!entry) {
      entry = {
        key: {
          aggregatorId: row.aggregatorId,
          orgSlug: row.orgSlug,
          linkId: row.linkId,
          hourBucketIso: bucketStart.toISOString(),
        },
        totals: { total: 0, passed: 0, failed: 0, skipped: 0, submissionIds: [] },
      };
      buckets.set(cacheKey, entry);
    }
    entry.totals.total += 1;
    if (row.outcome === 'passed') entry.totals.passed += 1;
    else if (row.outcome === 'failed') entry.totals.failed += 1;
    else if (row.outcome === 'skipped') entry.totals.skipped += 1;
    entry.totals.submissionIds.push(row.id);
  }

  // Conflict target: the partial unique index on (user, link, period_start) where source='link'.
  for (const { key, totals } of buckets.values()) {
    const periodStart = new Date(key.hourBucketIso);
    const periodEnd = new Date(periodStart.getTime() + 60 * 60 * 1000);
    await getDb()
      .insert(schema.onboarding)
      .values({
        userId: key.aggregatorId,
        signalstackOrgSlug: key.orgSlug,
        source: 'link',
        batchId: null,
        linkId: key.linkId,
        periodStart,
        periodEnd,
        total: totals.total,
        passed: totals.passed,
        failed: totals.failed,
        skipped: totals.skipped,
      })
      .onConflictDoUpdate({
        target: [schema.onboarding.userId, schema.onboarding.linkId, schema.onboarding.periodStart],
        targetWhere: sql`source = 'link'`,
        set: {
          total: sql`${schema.onboarding.total} + ${totals.total}`,
          passed: sql`${schema.onboarding.passed} + ${totals.passed}`,
          failed: sql`${schema.onboarding.failed} + ${totals.failed}`,
          skipped: sql`${schema.onboarding.skipped} + ${totals.skipped}`,
        },
      });
  }

  const allIds = rows.map((r) => r.id);
  await getDb()
    .update(schema.linkSubmissions)
    .set({ rolledUpAt: new Date() })
    .where(inArray(schema.linkSubmissions.id, allIds));

  log.info({
    status: 'success',
    latency_ms: Date.now() - start,
    submissions: rows.length,
    buckets: buckets.size,
  });
  return { status: 'rolled_up', submissions: rows.length, buckets: buckets.size };
}

function startOfHour(d: Date): Date {
  const out = new Date(d);
  out.setUTCMinutes(0, 0, 0);
  return out;
}
