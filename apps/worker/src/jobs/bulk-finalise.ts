/**
 * Bulk finaliser: writes the run summary for a bulk upload in the worker app.
 *
 * Steps:
 *   1. Read row errors from `bu:{id}:errors` and write errors.csv to S3
 *      (original header columns + error_category + error_reason).
 *   2. Mark the upload completed and insert the onboarding rollup row.
 *   3. Delete the `bu:{id}:*` Redis keys after the DB writes succeed.
 *
 * Idempotent: the jobId `${uploadId}__finalise` dedups triggers, the S3 key is
 * fixed, and the onboarding insert is skipped if the row already exists.
 */

import { and, eq } from 'drizzle-orm';
import Papa from 'papaparse';
import { type BulkFinaliseJob, bulkRedisKeys } from '@aggregator-dpg/queue';
import { schema, getDb } from '../db.js';
import { getRedis } from '../services/redis.js';
import { putObject } from '../object-storage.js';
import { logger } from '../logger.js';
import { CSV_FIELD_DELIMITER } from './bulk-file-stream.js';

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
      orgSlug: schema.users.signalstackOrgSlug,
    })
    .from(schema.bulkUploads)
    .innerJoin(schema.users, eq(schema.bulkUploads.userId, schema.users.id))
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

  // Mark finalising so status reads show progress.
  await getDb()
    .update(schema.bulkUploads)
    .set({ status: 'finalising', lastProgressAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.bulkUploads.id, job.uploadId));

  const redis = getRedis();
  const ns = `bu:${job.uploadId}`;

  // 3. Read errors, ordered by row_index.
  const errors = await readErrors(redis, `${ns}:errors`);
  errors.sort((a, b) => a.row_index - b.row_index);

  // 4. Counters come from Redis, which the Lua commit script keeps current.
  const counters = await redis.hgetall(`${ns}:counters`);
  const passed = Number.parseInt(counters['passed'] ?? '0', 10) || 0;
  const failed = Number.parseInt(counters['failed'] ?? '0', 10) || 0;
  const skipped = Number.parseInt(counters['skipped'] ?? '0', 10) || 0;
  const total = passed + failed + skipped;

  // 5. Write errors.csv only when at least one row failed.
  let errorsKey: string | null = null;
  if (failed > 0) {
    const headerCols = await readHeaderCols(redis, `${ns}:meta`);
    const csvHeader = [...headerCols, 'error_category', 'error_reason'];
    // Fetch stored cells for the failed rows only.
    const indices = errors.map((e) => String(e.row_index));
    const rawRows =
      indices.length > 0 ? await redis.hmget(`${ns}:lines`, ...indices) : ([] as (string | null)[]);
    const csvRows: string[][] = errors.map((e, i) => {
      const { cells, surplus } = fitToHeader(readStoredRow(rawRows[i] ?? ''), headerCols.length);
      const reasons = [...(e.reasons ?? [])];
      if (surplus > 0) reasons.push(surplusNote(headerCols.length + surplus, headerCols.length));
      return [
        ...cells.map(sanitiseCsvCell),
        sanitiseCsvCell(e.error_category ?? ''),
        sanitiseCsvCell(reasons.join('; ')),
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

  // 6. Mark completed and insert the rollup in one transaction. Otherwise a
  // failed insert would be skipped on retry by the `already_completed` guard.
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

    // Check first: the partial unique index on batch_id cannot be a Drizzle
    // ON CONFLICT target. The check runs inside the transaction so a parallel
    // finaliser cannot insert between the check and the insert.
    const existing = await tx
      .select({ id: schema.onboarding.id })
      .from(schema.onboarding)
      .where(and(eq(schema.onboarding.source, 'bulk'), eq(schema.onboarding.batchId, job.uploadId)))
      .limit(1);
    if (existing.length === 0) {
      await tx.insert(schema.onboarding).values({
        userId: upload.userId,
        signalstackOrgSlug: orgSlug,
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

  // 7. Delete Redis keys after the DB writes succeed.
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
 * Reads all error records from the errors hash, page by page.
 *
 * Malformed entries are skipped so one bad record does not block the run.
 */
async function readErrors(redis: ReturnType<typeof getRedis>, key: string): Promise<ErrorRecord[]> {
  const errors: ErrorRecord[] = [];
  // Recurse on the cursor until it returns to '0'.
  const scanFrom = async (cursor: string): Promise<void> => {
    const [next, fields] = (await redis.hscan(key, cursor, 'COUNT', 200)) as [string, string[]];
    for (let i = 1; i < fields.length; i += 2) {
      const raw = fields[i];
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as ErrorRecord;
        errors.push(parsed);
      } catch {
        // Skip malformed entry; the Redis counters still include it.
      }
    }
    if (next !== '0') await scanFrom(next);
  };
  await scanFrom('0');
  return errors;
}

/**
 * Reads the CSV header columns saved by the file processor.
 *
 * Returns [] when missing; errors.csv then has only the two error columns.
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
 * Reads a row stored under `bu:{id}:lines` back into its cells.
 *
 * Rows are stored as a JSON array of strings. Any other value is treated as a
 * CSV line and split on {@link CSV_FIELD_DELIMITER}.
 *
 * @param stored - The `:lines` value, or `''` when the row is missing.
 * @returns The row's cells, possibly ragged.
 */
function readStoredRow(stored: string): string[] {
  if (!stored) return [];
  if (stored.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.every((c) => typeof c === 'string')) return parsed;
    } catch {
      // Not JSON: a CSV line that starts with `[`.
    }
  }
  const result = Papa.parse<string[]>(stored, {
    header: false,
    skipEmptyLines: 'greedy',
    delimiter: CSV_FIELD_DELIMITER,
  });
  return (result.data[0] ?? []) as string[];
}

/**
 * Fits a row's cells to the header width for errors.csv.
 *
 * Pads short rows and truncates wide ones so the error columns line up.
 * With no header (`expectedCols` 0) no data cells are returned.
 *
 * @param cells - The row's cells as stored.
 * @param expectedCols - Number of header columns.
 * @returns The fitted cells, and how many surplus cells were dropped.
 */
function fitToHeader(cells: string[], expectedCols: number): { cells: string[]; surplus: number } {
  if (cells.length < expectedCols) {
    return {
      cells: [...cells, ...new Array<string>(expectedCols - cells.length).fill('')],
      surplus: 0,
    };
  }
  return {
    cells: cells.slice(0, expectedCols),
    surplus: expectedCols > 0 ? cells.length - expectedCols : 0,
  };
}

/**
 * Builds the errors.csv note for a row with more cells than the header.
 *
 * @param actual - Cells found in the row.
 * @param expected - Columns in the header.
 * @returns A one-line, user-facing note.
 */
function surplusNote(actual: number, expected: number): string {
  return (
    `row has ${actual} cells but the header has ${expected} columns; the extra cells are ` +
    'not shown (join multiple values with the list separator, not a comma)'
  );
}

/**
 * Prefixes formula-like cells with a single quote to block spreadsheet formula injection.
 *
 * Applies to cells starting with `=`, `+`, `-`, `@`, tab, or CR.
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
