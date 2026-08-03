/**
 * Bulk Finaliser — run-summary worker.
 *
 * Per onboarding-implementation.md §3.4:
 *   1. HSCAN bu:{id}:errors → stream into errors.csv on S3
 *      (key: bulk-uploads/{upload_id}/errors.csv).
 *   2. CSV format: original CSV header columns + error_category + error_reason.
 *   3. UPDATE bulk_uploads → status='completed', counters from Redis,
 *      errors_csv_s3_key, completed_at.
 *   4. INSERT onboarding (source='bulk', batch_id=upload_id, totals).
 *   5. DEL bu:{upload_id}:* — only after persistence succeeds.
 *
 * Idempotency:
 *   - BullMQ jobId `${uploadId}:finalise` ensures exactly-one trigger.
 *   - On retry: errors.csv key is deterministic (overwrites identical bytes);
 *     onboarding insert is guarded by a pre-check on (source='bulk', batch_id);
 *     UPDATE is overwrite-safe; DEL is no-op on second run.
 */

import { and, eq } from 'drizzle-orm';
import Papa from 'papaparse';
import { type BulkFinaliseJob, bulkRedisKeys } from '@aggregator-dpg/queue';
import { schema, getDb } from '../db.js';
import { getRedis } from '../services/redis.js';
import { putObject } from '../object-storage.js';
import { logger } from '../logger.js';

interface ErrorRecord {
  row_index: number;
  reasons: string[];
  error_category: string;
}

export interface FinaliseOutcome {
  status: 'completed' | 'skipped';
  reason?: string;
  total?: number;
  passed?: number;
  failed?: number;
  skipped?: number;
}

export async function finaliseBulk(job: BulkFinaliseJob): Promise<FinaliseOutcome> {
  const log = logger.child({
    operation: 'bulkFinalise',
    upload_id: job.uploadId,
  });
  const start = Date.now();

  // 1. Load upload + aggregator org_slug for the onboarding row.
  const found = await getDb()
    .select({
      upload: schema.bulkUploads,
      orgSlug: schema.aggregators.orgSlug,
    })
    .from(schema.bulkUploads)
    .innerJoin(schema.aggregators, eq(schema.bulkUploads.aggregatorId, schema.aggregators.id))
    .where(eq(schema.bulkUploads.id, job.uploadId))
    .limit(1);
  const row = found[0];
  if (!row) {
    log.warn({ status: 'skipped', reason: 'upload_missing' });
    return { status: 'skipped', reason: 'upload_missing' };
  }
  const { upload, orgSlug } = row;

  // 2. Status guard. Replay-safe: terminal states short-circuit.
  if (upload.status === 'completed') {
    log.info({ status: 'skipped', reason: 'already_completed' });
    return { status: 'skipped', reason: 'already_completed' };
  }
  if (upload.status === 'failed' || upload.status === 'file_failed') {
    log.warn({ status: 'skipped', reason: 'terminal_failure', current_status: upload.status });
    return { status: 'skipped', reason: 'terminal_failure' };
  }
  if (upload.status !== 'row_processing' && upload.status !== 'finalising') {
    log.warn({ status: 'skipped', reason: 'unexpected_status', current_status: upload.status });
    return { status: 'skipped', reason: 'unexpected_status' };
  }

  // Mark finalising — observability beacon for status reads while we're
  // streaming errors and writing onboarding.
  await getDb()
    .update(schema.bulkUploads)
    .set({ status: 'finalising', lastProgressAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.bulkUploads.id, job.uploadId));

  const redis = getRedis();
  const ns = `bu:${job.uploadId}`;

  // 3. Cursor-scan errors HSET; deterministic ordering by row_index.
  const errors = await readErrors(redis, `${ns}:errors`);
  errors.sort((a, b) => a.row_index - b.row_index);

  // 4. Authoritative counters first — drives the "do we need errors.csv?"
  // decision. Pulled directly from Redis (the Lua commit script is the
  // source of truth; periodic DB flushes lag).
  const counters = await redis.hgetall(`${ns}:counters`);
  const passed = parseInt(counters['passed'] ?? '0', 10) || 0;
  const failed = parseInt(counters['failed'] ?? '0', 10) || 0;
  const skipped = parseInt(counters['skipped'] ?? '0', 10) || 0;
  const total = passed + failed + skipped;

  // 5. Build + upload errors.csv only when there's at least one failure.
  // Empty CSV on a clean run wasted S3 storage and surfaced a misleading
  // "Download errors" button in the UI for runs that had nothing to report.
  let errorsKey: string | null = null;
  if (failed > 0) {
    const headerCols = await readHeaderCols(redis, `${ns}:meta`);
    const csvHeader = [...headerCols, 'error_category', 'error_reason'];
    // Fetch raw CSV lines for only the failed row indices in one round-trip.
    const indices = errors.map((e) => String(e.row_index));
    const rawRows =
      indices.length > 0 ? await redis.hmget(`${ns}:lines`, ...indices) : ([] as (string | null)[]);
    const csvRows: string[][] = errors.map((e, i) => {
      const cells = parseRawRow(rawRows[i] ?? '', headerCols.length).map(sanitiseCsvCell);
      return [
        ...cells,
        sanitiseCsvCell(e.error_category ?? ''),
        sanitiseCsvCell((e.reasons ?? []).join('; ')),
      ];
    });
    const csvBody = Papa.unparse({ fields: csvHeader, data: csvRows });
    errorsKey = `bulk-uploads/${job.uploadId}/errors.csv`;
    try {
      await putObject(errorsKey, Buffer.from(csvBody, 'utf8'), 'text/csv');
    } catch (err) {
      log.error({ status: 'failure', sub: 's3.put', error: (err as Error).message });
      throw err;
    }
  }

  // 6 + 7. Mark `bulk_uploads` completed AND insert the onboarding rollup
  // row atomically. If we update first and the onboarding INSERT then fails,
  // BullMQ retries hit the `already_completed` short-circuit (line above)
  // and the rollup is permanently lost. Single transaction prevents that.
  const completedAt = new Date();
  await getDb().transaction(async (tx) => {
    await tx
      .update(schema.bulkUploads)
      .set({
        status: 'completed',
        errorsCsvS3Key: errorsKey,
        completedAt,
        lastProgressAt: completedAt,
        updatedAt: completedAt,
      })
      .where(eq(schema.bulkUploads.id, job.uploadId));

    // Pre-check for idempotency on replay — the partial UNIQUE on
    // (batch_id WHERE source='bulk') can't be a Drizzle ON CONFLICT target
    // directly. Inside the same transaction so a parallel finaliser can't
    // sneak between the SELECT and INSERT.
    const existing = await tx
      .select({ id: schema.onboarding.id })
      .from(schema.onboarding)
      .where(and(eq(schema.onboarding.source, 'bulk'), eq(schema.onboarding.batchId, job.uploadId)))
      .limit(1);
    if (existing.length === 0) {
      await tx.insert(schema.onboarding).values({
        aggregatorId: upload.aggregatorId,
        orgSlug,
        source: 'bulk',
        batchId: job.uploadId,
        linkId: null,
        periodStart: upload.createdAt,
        periodEnd: completedAt,
        total,
        passed,
        failed,
        skipped,
      });
    }
  });

  // 8. Cleanup Redis keys — only after all persistence succeeded.
  await redis.del(...bulkRedisKeys(job.uploadId));

  log.info({
    status: 'success',
    event_type: 'audit',
    audit: 'bulkUpload.run_completed',
    latency_ms: Date.now() - start,
    total,
    passed,
    failed,
    skipped,
    errors_csv_s3_key: errorsKey,
  });
  return { status: 'completed', total, passed, failed, skipped };
}

/**
 * Memory-bounded HSCAN over the errors HASH. Parses each JSON value and
 * silently skips malformed entries — a corrupt error record must not block
 * finalisation of the rest of the run.
 */
async function readErrors(redis: ReturnType<typeof getRedis>, key: string): Promise<ErrorRecord[]> {
  const errors: ErrorRecord[] = [];
  let cursor = '0';
  do {
    const [next, fields] = (await redis.hscan(key, cursor, 'COUNT', 200)) as [string, string[]];
    for (let i = 1; i < fields.length; i += 2) {
      const raw = fields[i];
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as ErrorRecord;
        errors.push(parsed);
      } catch {
        // skip malformed entry — counter on bulk_uploads still reflects it
      }
    }
    cursor = next;
  } while (cursor !== '0');
  return errors;
}

/**
 * Reads the CSV header column list stashed by the File Processor on the
 * meta HASH. Returns [] on miss — Finaliser still emits a header with just
 * error_category + error_reason in that case.
 */
async function readHeaderCols(
  redis: ReturnType<typeof getRedis>,
  metaKey: string,
): Promise<string[]> {
  const headersJson = await redis.hget(metaKey, 'headers');
  if (!headersJson) return [];
  try {
    const parsed = JSON.parse(headersJson);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((c): c is string => typeof c === 'string');
  } catch {
    return [];
  }
}

/**
 * Reconstructs cells from a raw CSV line. With header=false Papaparse
 * returns a positional array; we pad to the expected width if the line is
 * shorter (defensive — File Processor already validates header coverage).
 */
function parseRawRow(rawRow: string, expectedCols: number): string[] {
  if (!rawRow) return Array(expectedCols).fill('');
  const result = Papa.parse<string[]>(rawRow, { header: false, skipEmptyLines: 'greedy' });
  const cells = (result.data[0] ?? []) as string[];
  if (cells.length < expectedCols) {
    return [...cells, ...Array(expectedCols - cells.length).fill('')];
  }
  return cells;
}

/**
 * Defuses spreadsheet formula injection. Cells starting with `=`, `+`, `-`,
 * `@`, tab, or CR are interpreted as formulas by Excel/LibreOffice when the
 * downloaded errors.csv is opened. Prefixing with a single quote keeps the
 * value visible but inert.
 */
function sanitiseCsvCell(value: string): string {
  if (!value) return value;
  const first = value.charAt(0);
  if (
    first === '=' ||
    first === '+' ||
    first === '-' ||
    first === '@' ||
    first === '\t' ||
    first === '\r'
  ) {
    return `'${value}`;
  }
  return value;
}
