/**
 * Unit tests for the Bulk Finaliser.
 *
 * `finaliseBulk` is a queue-consumer job that touches Postgres (via a
 * hand-built chainable Drizzle stub, matching the pattern already used by
 * `bulk-file-process.test.ts`), Redis (counters/errors/lines HASHes), and S3
 * (errors.csv upload). All three are faked here — no real DB/Redis/S3 in this
 * suite. Covers: normal completion (with and without a failed-row errors.csv),
 * every idempotency short-circuit, the idempotent-onboarding-exists replay,
 * and S3 failure propagation.
 *
 * @module @aggregator-dpg/worker
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Papa from 'papaparse';

// ─── Mutable fixtures read by the mocked db/redis/object-storage below ──────

let uploadRow: { upload: Record<string, unknown>; orgSlug: string } | null = null;
const outsideTxUpdates: Array<Record<string, unknown>> = [];
const txUpdates: Array<Record<string, unknown>> = [];
const insertedOnboarding: Array<Record<string, unknown>> = [];
let existingOnboarding: Array<{ id: string }> = [];

function makeDb() {
  return {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: async () => (uploadRow ? [uploadRow] : []),
          }),
        }),
      }),
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        outsideTxUpdates.push(v);
        return { where: async () => undefined };
      },
    }),
    transaction: async (cb: (tx: unknown) => Promise<void>) => {
      const tx = {
        update: () => ({
          set: (v: Record<string, unknown>) => {
            txUpdates.push(v);
            return { where: async () => undefined };
          },
        }),
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => existingOnboarding,
            }),
          }),
        }),
        insert: () => ({
          values: async (v: Record<string, unknown>) => {
            insertedOnboarding.push(v);
          },
        }),
      };
      await cb(tx);
    },
  };
}

vi.mock('../db.js', () => ({
  getDb: () => makeDb(),
  schema: {
    bulkUploads: { id: 'id', userId: 'userId' },
    users: { id: 'id', signalstackOrgSlug: 'signalstackOrgSlug' },
    onboarding: {
      id: 'id',
      source: 'source',
      batchId: 'batchId',
      userId: 'userId',
      linkId: 'linkId',
      periodStart: 'periodStart',
    },
  },
}));

// ─── Redis fake ──────────────────────────────────────────────────────────────

let hscanPages: Array<[string, string[]]> = [['0', []]];
let counters: Record<string, string> = { passed: '0', failed: '0', skipped: '0' };
let headersJson: string | null = null;
let hmgetReturn: (string | null)[] = [];
const delCalls: string[][] = [];

function makeRedis() {
  let hscanCallIdx = 0;
  return {
    hscan: vi.fn(async () => hscanPages[hscanCallIdx++] ?? ['0', []]),
    hgetall: vi.fn(async () => counters),
    hget: vi.fn(async () => headersJson),
    hmget: vi.fn(async (..._args: unknown[]) => hmgetReturn),
    del: vi.fn(async (...keys: string[]) => {
      delCalls.push(keys);
      return keys.length;
    }),
  };
}

vi.mock('../services/redis.js', () => ({ getRedis: () => makeRedis() }));

// ─── Object storage (S3) fake ────────────────────────────────────────────────

const putObject = vi.fn(async (_key: string, _body: Buffer, _contentType: string) => undefined);
vi.mock('../object-storage.js', () => ({ putObject }));

// ─── Config (only pulled in transitively via logger.js) ─────────────────────

vi.mock('../config.js', () => ({
  config: { LOG_LEVEL: 'silent', NODE_ENV: 'test' },
}));

const { finaliseBulk } = await import('./bulk-finalise.js');

const JOB = { uploadId: 'up-1' };

beforeEach(() => {
  vi.clearAllMocks();
  uploadRow = {
    upload: {
      id: 'up-1',
      userId: 'agg-1',
      status: 'row_processing',
      createdAt: new Date('2024-01-01T00:00:00Z'),
    },
    orgSlug: 'org-1',
  };
  outsideTxUpdates.length = 0;
  txUpdates.length = 0;
  insertedOnboarding.length = 0;
  existingOnboarding = [];
  hscanPages = [['0', []]];
  counters = { passed: '0', failed: '0', skipped: '0' };
  headersJson = null;
  hmgetReturn = [];
  delCalls.length = 0;
  putObject.mockResolvedValue(undefined);
});

describe('finaliseBulk — idempotency short-circuits', () => {
  it('skips when the upload row is missing', async () => {
    uploadRow = null;
    const res = await finaliseBulk(JOB);
    expect(res).toEqual({ status: 'skipped', reason: 'upload_missing' });
    expect(outsideTxUpdates).toHaveLength(0);
  });

  it('skips when already completed (replay-safe)', async () => {
    uploadRow!.upload['status'] = 'completed';
    const res = await finaliseBulk(JOB);
    expect(res).toEqual({ status: 'skipped', reason: 'already_completed' });
    expect(outsideTxUpdates).toHaveLength(0);
  });

  it.each(['failed', 'file_failed'])('skips terminal failure status=%s', async (status) => {
    uploadRow!.upload['status'] = status;
    const res = await finaliseBulk(JOB);
    expect(res).toEqual({ status: 'skipped', reason: 'terminal_failure' });
  });

  it.each(['pending', 'uploaded', 'file_validating'])(
    'skips an unexpected pre-processing status=%s',
    async (status) => {
      uploadRow!.upload['status'] = status;
      const res = await finaliseBulk(JOB);
      expect(res).toEqual({ status: 'skipped', reason: 'unexpected_status' });
    },
  );
});

describe('finaliseBulk — normal completion', () => {
  it('marks finalising, then completed, and cleans up Redis when there are no failures', async () => {
    counters = { passed: '3', failed: '0', skipped: '0' };

    const res = await finaliseBulk(JOB);

    expect(res).toEqual({ status: 'completed', total: 3, passed: 3, failed: 0, skipped: 0 });
    expect(outsideTxUpdates[0]).toMatchObject({ status: 'finalising' });
    expect(putObject).not.toHaveBeenCalled();
    expect(txUpdates[0]).toMatchObject({ status: 'completed', errorsCsvS3Key: null });
    expect(insertedOnboarding).toHaveLength(1);
    expect(insertedOnboarding[0]).toMatchObject({
      userId: 'agg-1',
      signalstackOrgSlug: 'org-1',
      source: 'bulk',
      batchId: 'up-1',
      total: 3,
      passed: 3,
      failed: 0,
      skipped: 0,
    });
    expect(delCalls).toHaveLength(1);
    expect(delCalls[0]).toEqual(expect.arrayContaining(['bu:up-1:lines', 'bu:up-1:meta']));
  });

  it('builds and uploads errors.csv when there is at least one failure', async () => {
    counters = { passed: '1', failed: '1', skipped: '0' };
    hscanPages = [
      [
        '0',
        [
          'err-0',
          JSON.stringify({ row_index: 0, reasons: ['bad email'], error_category: 'validation' }),
        ],
      ],
    ];
    headersJson = JSON.stringify(['name', 'email']);
    hmgetReturn = ['Asha,bad-email'];

    const res = await finaliseBulk(JOB);

    expect(res).toEqual({ status: 'completed', total: 2, passed: 1, failed: 1, skipped: 0 });
    expect(putObject).toHaveBeenCalledTimes(1);
    const [key, body, contentType] = putObject.mock.calls[0]!;
    expect(key).toBe('bulk-uploads/up-1/errors.csv');
    expect(contentType).toBe('text/csv');
    const csv = (body as Buffer).toString('utf8');
    expect(csv).toContain('name');
    expect(csv).toContain('email');
    expect(csv).toContain('error_category');
    expect(csv).toContain('error_reason');
    expect(csv).toContain('validation');
    expect(csv).toContain('bad email');
    expect(txUpdates[0]).toMatchObject({
      status: 'completed',
      errorsCsvS3Key: 'bulk-uploads/up-1/errors.csv',
    });
  });

  it('skips the onboarding INSERT (but still marks completed) on an idempotent replay', async () => {
    counters = { passed: '2', failed: '0', skipped: '0' };
    existingOnboarding = [{ id: 'existing-onboarding-row' }];

    const res = await finaliseBulk(JOB);

    expect(res.status).toBe('completed');
    expect(insertedOnboarding).toHaveLength(0);
    expect(txUpdates[0]).toMatchObject({ status: 'completed' });
  });

  it('defaults counters to 0 when the Redis hash is empty (defensive parseInt fallback)', async () => {
    counters = {};
    const res = await finaliseBulk(JOB);
    expect(res).toEqual({ status: 'completed', total: 0, passed: 0, failed: 0, skipped: 0 });
  });

  it('silently skips a malformed JSON error entry but still finalises using authoritative Redis counters', async () => {
    counters = { passed: '0', failed: '1', skipped: '0' };
    hscanPages = [['0', ['err-bad', 'not-json-{{']]];
    headersJson = null; // exercise the "no headers on file" fallback too

    const res = await finaliseBulk(JOB);

    expect(res.status).toBe('completed');
    expect(res.failed).toBe(1);
    // The single error record was malformed and dropped, so no row_index to
    // hmget for — indices is empty and hmget must not be called at all.
    expect(putObject).toHaveBeenCalledTimes(1);
    const csv = (putObject.mock.calls[0]![1] as Buffer).toString('utf8');
    // No stashed headers -> only the two synthetic columns appear.
    expect(csv.split('\n')[0]!.trim()).toBe('error_category,error_reason');
  });

  it('pads a raw CSV line that is shorter than the header (defensive, ragged row)', async () => {
    counters = { passed: '0', failed: '1', skipped: '0' };
    hscanPages = [
      [
        '0',
        [
          'err-0',
          JSON.stringify({ row_index: 0, reasons: ['missing city'], error_category: 'validation' }),
        ],
      ],
    ];
    headersJson = JSON.stringify(['name', 'email', 'city']);
    hmgetReturn = ['Asha,asha@x.io']; // only 2 of 3 header columns present

    const res = await finaliseBulk(JOB);
    expect(res.failed).toBe(1);
    const csv = (putObject.mock.calls[0]![1] as Buffer).toString('utf8');
    const dataLine = csv.split('\n')[1]!;
    // name,email,city(padded-empty),error_category,error_reason
    expect(dataLine).toBe('Asha,asha@x.io,,validation,missing city');
  });

  it('rebuilds a row from its stored JSON cells, untouched by "|", "," or quotes', async () => {
    counters = { passed: '0', failed: '1', skipped: '0' };
    hscanPages = [
      [
        '0',
        [
          'err-0',
          JSON.stringify({ row_index: 0, reasons: ['bad category'], error_category: 'validation' }),
        ],
      ],
    ];
    headersJson = JSON.stringify(['name', 'disabilities', 'address']);
    hmgetReturn = [
      JSON.stringify(['Asha', 'Blindness|Deaf|Low Vision|Dwarfism|Hemophilia', 'Basti, "UP"']),
    ];

    await finaliseBulk(JOB);
    const csv = (putObject.mock.calls[0]![1] as Buffer).toString('utf8');
    const [cells] = Papa.parse<string[]>(csv.split('\n')[1]!, { delimiter: ',' }).data;
    expect(cells).toEqual([
      'Asha',
      'Blindness|Deaf|Low Vision|Dwarfism|Hemophilia',
      'Basti, "UP"',
      'validation',
      'bad category',
    ]);
  });

  it('keeps the error columns for a stored JSON row wider than the header', async () => {
    counters = { passed: '0', failed: '1', skipped: '0' };
    hscanPages = [
      ['0', ['err-0', JSON.stringify({ row_index: 0, reasons: ['bad'], error_category: 'v' })]],
    ];
    headersJson = JSON.stringify(['name']);
    hmgetReturn = [JSON.stringify(['Asha', 'extra'])];

    await finaliseBulk(JOB);
    const csv = (putObject.mock.calls[0]![1] as Buffer).toString('utf8');
    const [cells] = Papa.parse<string[]>(csv.split('\n')[1]!, { delimiter: ',' }).data;
    expect(cells!.slice(0, 2)).toEqual(['Asha', 'v']);
    expect(cells![2]).toMatch(/^bad; row has 2 cells but the header has 1 columns/);
  });

  it('legacy CSV line (previous release): re-parses on "," even when it carries more "|" than ","', async () => {
    // Multi-value cells are joined with `|`. Left to auto-detect, a single row
    // with more pipes than commas was split on `|`, shifting every cell and
    // pushing the error columns off the end of errors.csv.
    counters = { passed: '0', failed: '1', skipped: '0' };
    hscanPages = [
      [
        '0',
        [
          'err-0',
          JSON.stringify({ row_index: 0, reasons: ['bad category'], error_category: 'validation' }),
        ],
      ],
    ];
    headersJson = JSON.stringify(['name', 'disabilities', 'city']);
    hmgetReturn = ['Asha,Blindness|Deaf|Low Vision|Dwarfism|Hemophilia|Thalassemia,Basti'];

    await finaliseBulk(JOB);
    const csv = (putObject.mock.calls[0]![1] as Buffer).toString('utf8');
    expect(csv.split('\n')[1]!.trim()).toBe(
      'Asha,Blindness|Deaf|Low Vision|Dwarfism|Hemophilia|Thalassemia,Basti,validation,bad category',
    );
  });

  it('legacy CSV line: keeps the error columns for a row wider than the header and says why', async () => {
    counters = { passed: '0', failed: '1', skipped: '0' };
    hscanPages = [
      [
        '0',
        [
          'err-0',
          JSON.stringify({ row_index: 0, reasons: ['bad city'], error_category: 'validation' }),
        ],
      ],
    ];
    headersJson = JSON.stringify(['name', 'city']);
    hmgetReturn = ['Asha,Basti,extra one,extra two'];

    await finaliseBulk(JOB);
    const csv = (putObject.mock.calls[0]![1] as Buffer).toString('utf8');
    const [cells] = Papa.parse<string[]>(csv.split('\n')[1]!, { delimiter: ',' }).data;
    expect(cells).toHaveLength(4);
    expect(cells!.slice(0, 3)).toEqual(['Asha', 'Basti', 'validation']);
    expect(cells![3]).toMatch(/^bad city; row has 4 cells but the header has 2 columns/);
  });

  it('defuses spreadsheet-formula-injection cells in errors.csv (security)', async () => {
    counters = { passed: '0', failed: '1', skipped: '0' };
    hscanPages = [
      [
        '0',
        ['err-0', JSON.stringify({ row_index: 0, reasons: ['bad'], error_category: 'validation' })],
      ],
    ];
    headersJson = JSON.stringify(['name']);
    hmgetReturn = ['=SUM(A1:A10)'];

    const res = await finaliseBulk(JOB);
    expect(res.failed).toBe(1);
    const csv = (putObject.mock.calls[0]![1] as Buffer).toString('utf8');
    // The raw cell value is preserved but prefixed with a quote so a
    // spreadsheet app renders it as inert text, not a formula.
    expect(csv).toContain(`'=SUM(A1:A10)`);
  });

  it('falls back to a headers-only CSV when the stashed :meta headers JSON is malformed', async () => {
    counters = { passed: '0', failed: '1', skipped: '0' };
    hscanPages = [
      ['0', ['err-0', JSON.stringify({ row_index: 0, reasons: ['bad'], error_category: 'x' })]],
    ];
    headersJson = 'not-json{{';
    hmgetReturn = ['some,raw,row'];

    const res = await finaliseBulk(JOB);
    expect(res.failed).toBe(1);
    const csv = (putObject.mock.calls[0]![1] as Buffer).toString('utf8');
    expect(csv.split('\n')[0]!.trim()).toBe('error_category,error_reason');
  });

  it('falls back to a headers-only CSV when the stashed :meta headers JSON is not an array', async () => {
    counters = { passed: '0', failed: '1', skipped: '0' };
    hscanPages = [
      ['0', ['err-0', JSON.stringify({ row_index: 0, reasons: ['bad'], error_category: 'x' })]],
    ];
    headersJson = JSON.stringify({ not: 'an array' });

    const res = await finaliseBulk(JOB);
    expect(res.failed).toBe(1);
    const csv = (putObject.mock.calls[0]![1] as Buffer).toString('utf8');
    expect(csv.split('\n')[0]!.trim()).toBe('error_category,error_reason');
  });

  it('paginates through multiple HSCAN cursors before finalising', async () => {
    counters = { passed: '0', failed: '2', skipped: '0' };
    hscanPages = [
      ['17', ['err-0', JSON.stringify({ row_index: 0, reasons: ['a'], error_category: 'x' })]],
      ['0', ['err-1', JSON.stringify({ row_index: 1, reasons: ['b'], error_category: 'y' })]],
    ];
    hmgetReturn = ['row0', 'row1'];

    const res = await finaliseBulk(JOB);
    expect(res.failed).toBe(2);
    const csv = (putObject.mock.calls[0]![1] as Buffer).toString('utf8');
    // No header was stashed, so only the error columns are written — one line
    // per failure from BOTH cursor pages. (This used to print `row0,x`: the raw
    // cell displaced the category and the reason fell off the end.)
    expect(csv).toContain('x,a');
    expect(csv).toContain('y,b');
  });
});

describe('finaliseBulk — failure propagation', () => {
  it('re-throws (does not swallow) an S3 put failure and never reaches the completion transaction', async () => {
    counters = { passed: '0', failed: '1', skipped: '0' };
    hscanPages = [
      ['0', ['err-0', JSON.stringify({ row_index: 0, reasons: ['bad'], error_category: 'x' })]],
    ];
    putObject.mockRejectedValueOnce(new Error('s3 unreachable'));

    await expect(finaliseBulk(JOB)).rejects.toThrow('s3 unreachable');
    expect(txUpdates).toHaveLength(0);
    expect(insertedOnboarding).toHaveLength(0);
  });
});
