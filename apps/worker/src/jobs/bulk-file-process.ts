/**
 * Bulk file processor: file-level checks for a bulk upload in the worker app.
 *
 * Steps:
 *   1. Load the JSON Schema for the upload.
 *   2. Stream-parse the S3 object (UTF-8, header check, per-row limits).
 *   3. Set status to `row_processing`, save headers and row cells for the
 *      finaliser, and enqueue one job per row.
 *   4. Publish total_rows and reader_done only after every row job is enqueued.
 *
 * A rejected file enqueues no rows and is marked `file_failed`.
 * Replays are skipped once the upload is at `row_processing` or later.
 */

import { eq } from 'drizzle-orm';
import type { BulkFileProcessJob } from '@aggregator-dpg/queue';
import { schema, getDb } from '../db.js';
import { getCsvStream } from '../object-storage.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getSchemaLoader } from '../services/schema-loader.js';
import { getRedis } from '../services/redis.js';
import { enqueueRowProcessBulk } from '../services/bulk-queue.js';
import { streamCsvParse, type FileFailureReason } from './bulk-file-stream.js';
import { WELL_KNOWN_COLUMNS } from '@aggregator-dpg/shared-primitives/bulk-columns';

export type { FileFailureReason };

/** Rows enqueued per BullMQ `addBulk` batch + Redis `:lines` write. */
const ENQUEUE_CHUNK = 1000;

interface ProcessOutcome {
  status: 'enqueued' | 'failed';
  totalRows?: number;
  reason?: FileFailureReason;
  detail?: string;
}

/** Builds the `status_reason` text for a file-level failure. */
function failureReason(reason: FileFailureReason, detail?: string): string {
  if (detail && (reason === 'header_mismatch' || reason === 'row_cap_exceeded')) {
    return `${reason}: ${detail}`;
  }
  return reason;
}

export async function processBulkFile(job: BulkFileProcessJob): Promise<ProcessOutcome> {
  const log = logger.child({
    operation: 'bulkFileProcess',
    upload_id: job.uploadId,
    aggregator_id: job.aggregatorId,
  });
  const start = Date.now();

  // Skip if the upload is already past file_validating.
  const existing = await getDb()
    .select()
    .from(schema.bulkUploads)
    .where(eq(schema.bulkUploads.id, job.uploadId))
    .limit(1);
  const row = existing[0];
  if (!row) {
    log.warn({ status: 'skipped', reason: 'row_missing' });
    return { status: 'failed', reason: 'system_error', detail: 'upload row missing' };
  }
  const TERMINAL_OR_LATER = new Set([
    'row_processing',
    'finalising',
    'completed',
    'failed',
    'file_failed',
  ]);
  if (TERMINAL_OR_LATER.has(row.status)) {
    log.info({ status: 'skipped', reason: 'already_progressed', current_status: row.status });
    return { status: 'enqueued' };
  }

  await markStatus(job.uploadId, 'file_validating', null);

  // 1. Load validator and schema (both cached by the loader).
  const loader = getSchemaLoader();
  const ref = { id: job.schemaId, version: job.schemaVersion };
  const [validatorResult, schemaResult] = await Promise.all([
    loader.getValidator(ref),
    loader.getSchema(ref),
  ]);
  if (!validatorResult.success) {
    log.error({ status: 'failure', sub: 'schema.load', error: validatorResult.error.code });
    await markStatus(job.uploadId, 'file_failed', 'schema_unavailable');
    return { status: 'failed', reason: 'schema_unavailable' };
  }
  if (!schemaResult.success) {
    log.error({ status: 'failure', sub: 'schema.load', error: schemaResult.error.code });
    await markStatus(job.uploadId, 'file_failed', 'schema_unavailable');
    return { status: 'failed', reason: 'schema_unavailable' };
  }

  // 2. Stream-parse the S3 body. No rows are returned on failure.
  let stream;
  try {
    stream = await getCsvStream(job.s3Key);
  } catch (err) {
    log.error({ status: 'failure', sub: 's3.get', error: (err as Error).message });
    await markStatus(job.uploadId, 'file_failed', 'system_error');
    return { status: 'failed', reason: 'system_error' };
  }

  const required = extractRequiredFields(schemaResult.value);
  // Well-known columns are allowed but never required.
  const allowed = new Set([...extractAllProperties(schemaResult.value), ...WELL_KNOWN_COLUMNS]);
  const parsed = await streamCsvParse(stream, {
    required,
    allowed,
    maxRows: config.BULK_MAX_ROWS,
    maxRowBytes: config.BULK_MAX_ROW_BYTES,
  });

  if (parsed.status === 'failed') {
    log.warn({ status: 'failure', reason: parsed.reason, detail: parsed.detail });
    await markStatus(job.uploadId, 'file_failed', failureReason(parsed.reason, parsed.detail));
    return {
      status: 'failed',
      reason: parsed.reason,
      ...(parsed.detail !== undefined ? { detail: parsed.detail } : {}),
    };
  }

  const { headers, rows } = parsed;

  // 3. Move to row_processing. The row total is kept in Redis (step 4).
  await getDb()
    .update(schema.bulkUploads)
    .set({
      status: 'row_processing',
      lastProgressAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.bulkUploads.id, job.uploadId));

  // 4. Enqueue row jobs before setting total and reader_done. Otherwise the
  // row processor could see `processed == total` early and finalise too soon.
  const redis = getRedis();
  const ns = `bu:${job.uploadId}`;
  // Save header columns so the finaliser can write errors.csv in the same order.
  await redis.hset(
    `${ns}:meta`,
    'started_at',
    String(Date.now()),
    'headers',
    JSON.stringify(headers),
  );

  // Chunks run one after another. Each chunk's `:lines` must be written
  // before its jobs are enqueued; running in sequence also bounds load.
  const writeChunk = async (slice: typeof rows): Promise<void> => {
    const payloads = slice.map((r) => ({
      uploadId: job.uploadId,
      aggregatorId: job.aggregatorId,
      rowIndex: r.rowIndex,
      schemaId: job.schemaId,
      schemaVersion: job.schemaVersion,
      participantType: job.participantType,
      payload: r.payload,
    }));

    // Save each row's cells as a JSON array for the finaliser.
    const linesArgs: string[] = [];
    for (const r of slice) {
      linesArgs.push(String(r.rowIndex), JSON.stringify(r.cells));
    }
    if (linesArgs.length > 0) {
      await redis.hset(`${ns}:lines`, ...linesArgs);
    }

    await enqueueRowProcessBulk(payloads);
  };
  const chunks: (typeof rows)[] = [];
  for (let off = 0; off < rows.length; off += ENQUEUE_CHUNK) {
    chunks.push(rows.slice(off, off + ENQUEUE_CHUNK));
  }
  await chunks.reduce<Promise<void>>(
    (prev, slice) => prev.then(() => writeChunk(slice)),
    Promise.resolve(),
  );

  await redis.hset(`${ns}:meta`, 'total_rows', String(rows.length), 'reader_done', '1');

  // `:lines` holds PII. The finaliser deletes it on success; the TTL covers
  // failed or abandoned uploads. The row commit script refreshes the TTL on its keys.
  const ttl = config.BULK_UPLOAD_REDIS_TTL_SECONDS;
  await redis.expire(`${ns}:meta`, ttl);
  await redis.expire(`${ns}:lines`, ttl);

  log.info({
    status: 'success',
    event_type: 'audit',
    audit: 'bulkUpload.run_started',
    latency_ms: Date.now() - start,
    total_rows: rows.length,
    enqueued: rows.length,
  });
  return { status: 'enqueued', totalRows: rows.length };
}

async function markStatus(
  uploadId: string,
  status:
    | 'pending'
    | 'uploaded'
    | 'file_validating'
    | 'file_failed'
    | 'row_processing'
    | 'finalising'
    | 'completed'
    | 'failed',
  reason: string | null,
): Promise<void> {
  await getDb()
    .update(schema.bulkUploads)
    .set({
      status,
      statusReason: reason,
      lastProgressAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.bulkUploads.id, uploadId));
}

function extractRequiredFields(s: Record<string, unknown>): string[] {
  const required = s['required'];
  return Array.isArray(required) ? required.filter((x): x is string => typeof x === 'string') : [];
}

function extractAllProperties(s: Record<string, unknown>): string[] {
  const props = s['properties'];
  if (!props || typeof props !== 'object') return [];
  return Object.keys(props as Record<string, unknown>);
}
