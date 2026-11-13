/**
 * Orchestration tests for the streaming File Processor.
 *
 * The pure parse/validation logic is covered in `bulk-file-stream.test.ts`.
 * These tests pin the wiring `processBulkFile` is responsible for: the
 * idempotency guard, status transitions, the Finaliser contracts on Redis
 * (`:meta` headers, the `:lines` hash keyed by rowIndex), and the ordering
 * invariant that `reader_done` is published only AFTER every row job is
 * enqueued. All I/O dependencies are faked — no S3, Redis, or DB.
 *
 * @module @aggregator-dpg/worker
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';

// ─── Mocks (declared before importing the SUT) ──────────────────────────────

const calls: string[] = [];

const hset = vi.fn(async (key: string, ...args: unknown[]) => {
  if (key.endsWith(':meta') && args.includes('reader_done')) calls.push('reader_done');
  if (key.endsWith(':lines')) calls.push('lines');
  return 1;
});
const expire = vi.fn(async (_key: string, _ttl: number) => 1);
const enqueueRowProcessBulk = vi.fn(async () => {
  calls.push('enqueue');
});

const uploadRow = { status: 'uploaded' };
const updates: Array<Record<string, unknown>> = [];
let selectRowMissing = false;

// Chainable Drizzle stub: `where` is thenable (resolves the awaited update path)
// and also exposes `.limit` for the select path.
function makeDb() {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'update']) chain[m] = () => chain;
  chain['set'] = (v: Record<string, unknown>) => {
    updates.push(v);
    return chain;
  };
  chain['where'] = () => chain;
  chain['limit'] = async () => (selectRowMissing ? [] : [uploadRow]);
  chain['then'] = (resolve: (v: unknown) => void) => resolve(undefined);
  return chain;
}

vi.mock('../db.js', () => ({
  getDb: () => makeDb(),
  schema: { bulkUploads: { id: 'id' } },
}));
vi.mock('../services/redis.js', () => ({ getRedis: () => ({ hset, expire }) }));
vi.mock('../services/bulk-queue.js', () => ({ enqueueRowProcessBulk }));
vi.mock('../object-storage.js', () => ({
  getCsvStream: vi.fn(async () =>
    Readable.from([Buffer.from('name,email\nAsha,a@x.io\nRavi,r@x.io', 'utf8')]),
  ),
}));
const getValidator = vi.fn(async () => ({ success: true, value: {} }));
const getSchema = vi.fn(async () => ({
  success: true,
  value: { required: ['name', 'email'], properties: { name: {}, email: {} } },
}));
vi.mock('../services/schema-loader.js', () => ({
  getSchemaLoader: () => ({ getValidator, getSchema }),
}));
vi.mock('../config.js', () => ({
  config: {
    BULK_MAX_ROWS: 10000,
    BULK_MAX_ROW_BYTES: 64 * 1024,
    BULK_UPLOAD_REDIS_TTL_SECONDS: 86_400,
    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
  },
}));

const { processBulkFile } = await import('./bulk-file-process.js');

const JOB = {
  uploadId: 'up-1',
  aggregatorId: 'agg-1',
  s3Key: 'bulk-uploads/up-1/source.csv',
  participantType: 'seeker',
  schemaId: 'participant-seeker',
  schemaVersion: 'v1',
};

beforeEach(() => {
  calls.length = 0;
  updates.length = 0;
  uploadRow.status = 'uploaded';
  selectRowMissing = false;
  vi.clearAllMocks();
});

describe('processBulkFile — success path', () => {
  it('enqueues rows then publishes reader_done (ordering invariant)', async () => {
    const res = await processBulkFile(JOB);
    expect(res).toEqual({ status: 'enqueued', totalRows: 2 });
    // reader_done must come strictly after the enqueue.
    expect(calls).toContain('enqueue');
    expect(calls).toContain('reader_done');
    expect(calls.indexOf('reader_done')).toBeGreaterThan(calls.lastIndexOf('enqueue'));
  });

  it('writes the :lines hash before enqueueing the chunk', async () => {
    await processBulkFile(JOB);
    expect(calls.indexOf('lines')).toBeLessThan(calls.indexOf('enqueue'));
  });

  it('stores each row in :lines as a JSON array of its cells (no CSV re-parse later)', async () => {
    await processBulkFile(JOB);
    const linesCall = hset.mock.calls.find(([key]) => String(key).endsWith(':lines'));
    expect(linesCall).toBeDefined();
    const [, ...fieldValues] = linesCall!;
    expect(fieldValues[0]).toBe('0');
    const stored = JSON.parse(String(fieldValues[1])) as unknown;
    expect(Array.isArray(stored)).toBe(true);
    expect((stored as unknown[]).every((c) => typeof c === 'string')).toBe(true);
  });

  it('processes chunks strictly in order, each writing :lines before its enqueue', async () => {
    // 2,001 rows → three chunks (ENQUEUE_CHUNK = 1000). The promise chain must keep them
    // serial: lines, enqueue, lines, enqueue, lines, enqueue.
    const body = ['name,email', ...Array.from({ length: 2001 }, (_, i) => `P${i},p${i}@x.io`)];
    const { getCsvStream } = await import('../object-storage.js');
    vi.mocked(getCsvStream).mockResolvedValueOnce(
      Readable.from([Buffer.from(body.join('\n'), 'utf8')]),
    );
    await processBulkFile(JOB);
    const order = calls.filter((c) => c === 'lines' || c === 'enqueue');
    expect(order).toEqual(['lines', 'enqueue', 'lines', 'enqueue', 'lines', 'enqueue']);
  });

  it('transitions the upload to row_processing', async () => {
    await processBulkFile(JOB);
    expect(updates.some((u) => u['status'] === 'row_processing')).toBe(true);
  });

  it('sets the configured TTL on the PII-bearing :lines and :meta keys', async () => {
    await processBulkFile(JOB);
    const expired = expire.mock.calls.map(([key, ttl]) => `${key}=${ttl}`);
    expect(expired).toContain('bu:up-1:lines=86400');
    expect(expired).toContain('bu:up-1:meta=86400');
  });
});

describe('processBulkFile — idempotency + failure', () => {
  it('short-circuits when the upload already progressed', async () => {
    uploadRow.status = 'completed';
    const res = await processBulkFile(JOB);
    expect(res).toEqual({ status: 'enqueued' });
    expect(enqueueRowProcessBulk).not.toHaveBeenCalled();
  });

  it('marks file_failed and enqueues nothing on header mismatch', async () => {
    const { getCsvStream } = await import('../object-storage.js');
    vi.mocked(getCsvStream).mockResolvedValueOnce(
      Readable.from([Buffer.from('name,phone\nAsha,123', 'utf8')]),
    );
    const res = await processBulkFile(JOB);
    expect(res.status).toBe('failed');
    expect(res.reason).toBe('header_mismatch');
    expect(enqueueRowProcessBulk).not.toHaveBeenCalled();
    expect(updates.some((u) => u['status'] === 'file_failed')).toBe(true);
  });

  it('accepts a well-known column in the header (#807)', async () => {
    // The single line that makes geo_location work at all is the
    // `...WELL_KNOWN_COLUMNS` union in the allowlist. Without it the header
    // check rejects the column as unknown and the WHOLE file onboards zero
    // rows — so every CSV downloaded from the new template would fail, and
    // none of the row-level behaviour is ever reached.
    const { getCsvStream } = await import('../object-storage.js');
    vi.mocked(getCsvStream).mockResolvedValueOnce(
      Readable.from([Buffer.from('name,email,geo_location\nAsha,a@b.c,12.9352|77.6245', 'utf8')]),
    );
    const res = await processBulkFile(JOB);
    expect(res.status).not.toBe('failed');
    expect(enqueueRowProcessBulk).toHaveBeenCalled();
  });

  it('still rejects a genuinely unknown column', async () => {
    // The allowlist is a union, not a bypass — anything outside the schema's
    // properties and the well-known set must still fail the file.
    const { getCsvStream } = await import('../object-storage.js');
    vi.mocked(getCsvStream).mockResolvedValueOnce(
      Readable.from([Buffer.from('name,email,not_a_column\nAsha,a@b.c,x', 'utf8')]),
    );
    const res = await processBulkFile(JOB);
    expect(res.status).toBe('failed');
    expect(res.reason).toBe('header_mismatch');
  });

  it('marks file_failed with a bare (non-detailed) reason for a failure kind that carries no detail', async () => {
    const { getCsvStream } = await import('../object-storage.js');
    vi.mocked(getCsvStream).mockResolvedValueOnce(Readable.from([Buffer.from('', 'utf8')]));
    const res = await processBulkFile(JOB);
    expect(res.status).toBe('failed');
    expect(res.reason).toBe('empty_csv');
    expect(updates.some((u) => u['statusReason'] === 'empty_csv')).toBe(true);
  });

  it('reports a system_error when the upload row itself is missing', async () => {
    selectRowMissing = true;
    const res = await processBulkFile(JOB);
    expect(res).toEqual({ status: 'failed', reason: 'system_error', detail: 'upload row missing' });
    expect(enqueueRowProcessBulk).not.toHaveBeenCalled();
  });

  it('marks file_failed when the validator itself fails to load', async () => {
    getValidator.mockResolvedValueOnce({
      success: false,
      error: { code: 'VALIDATOR_COMPILE_FAILED' },
    } as never);
    const res = await processBulkFile(JOB);
    expect(res).toEqual({ status: 'failed', reason: 'schema_unavailable' });
    expect(enqueueRowProcessBulk).not.toHaveBeenCalled();
    expect(
      updates.some(
        (u) => u['status'] === 'file_failed' && u['statusReason'] === 'schema_unavailable',
      ),
    ).toBe(true);
  });

  it('marks file_failed and enqueues nothing when the schema itself fails to load', async () => {
    getSchema.mockResolvedValueOnce({
      success: false,
      error: { code: 'SCHEMA_NOT_FOUND' },
    } as never);
    const res = await processBulkFile(JOB);
    expect(res).toEqual({ status: 'failed', reason: 'schema_unavailable' });
    expect(enqueueRowProcessBulk).not.toHaveBeenCalled();
    expect(
      updates.some(
        (u) => u['status'] === 'file_failed' && u['statusReason'] === 'schema_unavailable',
      ),
    ).toBe(true);
  });

  it('marks file_failed with system_error when the S3 GetObject call throws', async () => {
    const { getCsvStream } = await import('../object-storage.js');
    vi.mocked(getCsvStream).mockRejectedValueOnce(new Error('s3 timeout'));
    const res = await processBulkFile(JOB);
    expect(res).toEqual({ status: 'failed', reason: 'system_error' });
    expect(enqueueRowProcessBulk).not.toHaveBeenCalled();
    expect(
      updates.some((u) => u['status'] === 'file_failed' && u['statusReason'] === 'system_error'),
    ).toBe(true);
  });
});
