/**
 * Unit tests for PostgresBulkUploadsStore.
 *
 * The Drizzle client (`getDb()`) is swapped for a hand-built stub mimicking
 * its fluent, thenable query-builder chain (per testing.md §1 — third-party
 * adapters may be stubbed rather than faked), matching the pattern in
 * `packages/consent-ledger/src/__tests__/consent-ledger.test.ts`.
 * Every chained call is recorded so a test can assert on the exact values
 * passed into `.values()` / `.set()`, and the terminal `await` resolves to
 * whatever the test configures — this exercises the real
 * create/markUploaded-transition-guard/error-mapping logic in `postgres.ts`
 * without a live database.
 *
 * @module @aggregator-dpg/api
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PostgresBulkUploadsStore } from '../postgres.js';
import { _setDbClients } from '../../../db/client.js';
import type { BulkUpload, CreateBulkUploadInput } from '../interface.js';

// ─── Fake Drizzle chain ─────────────────────────────────────────────────────

interface ChainCall {
  method: string;
  args: unknown[];
}

function makeFakeDb(resolve: (chain: ChainCall[]) => unknown): unknown {
  function build(chain: ChainCall[]): unknown {
    return new Proxy(
      {},
      {
        get(_target, prop: string | symbol) {
          if (prop === 'then') {
            return (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) => {
              let result: unknown;
              try {
                result = resolve(chain);
              } catch (e) {
                return onRejected ? Promise.resolve(onRejected(e)) : Promise.reject(e);
              }
              return Promise.resolve(result).then(onFulfilled, onRejected);
            };
          }
          if (prop === 'catch') {
            return (onRejected: (e: unknown) => unknown) =>
              (build(chain) as Promise<unknown>).then(undefined, onRejected);
          }
          return (...args: unknown[]) => build([...chain, { method: String(prop), args }]);
        },
      },
    );
  }
  return build([]);
}

function callArgs(chain: ChainCall[], method: string): unknown[] | undefined {
  return chain.find((c) => c.method === method)?.args;
}

function hasCall(chain: ChainCall[], method: string): boolean {
  return chain.some((c) => c.method === method);
}

afterEach(() => {
  _setDbClients(null, null);
});

function makeRow(overrides: Partial<BulkUpload> = {}): BulkUpload {
  const createdAt = overrides.createdAt ?? new Date('2026-01-01T00:00:00Z');
  return {
    id: 'upload-1',
    aggregatorId: 'agg-1',
    participantType: 'seeker',
    s3Key: 'uploads/upload-1.csv',
    s3Etag: null,
    status: 'pending',
    statusReason: null,
    errorsCsvS3Key: null,
    schemaId: 'seeker_profile',
    schemaVersion: '1.0',
    uploadedBy: 'coordinator-1',
    lastProgressAt: null,
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
    ...overrides,
  };
}

function makeInput(overrides: Partial<CreateBulkUploadInput> = {}): CreateBulkUploadInput {
  return {
    aggregatorId: 'agg-1',
    participantType: 'seeker',
    s3Key: 'uploads/upload-1.csv',
    schemaId: 'seeker_profile',
    schemaVersion: '1.0',
    uploadedBy: 'coordinator-1',
    ...overrides,
  };
}

// ─── create ─────────────────────────────────────────────────────────────────

describe('PostgresBulkUploadsStore.create', () => {
  it('inserts the mapped row and returns it on success', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      captured = chain;
      return [makeRow({ id: 'upload-9' })];
    });
    _setDbClients(null, db as never);
    const store = new PostgresBulkUploadsStore();

    const result = await store.create(makeInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe('upload-9');
    expect(callArgs(captured, 'values')?.[0]).toMatchObject({
      userId: 'agg-1',
      participantType: 'seeker',
      s3Key: 'uploads/upload-1.csv',
      schemaId: 'seeker_profile',
      schemaVersion: '1.0',
      uploadedBy: 'coordinator-1',
    });
  });

  it('returns DB_UNAVAILABLE when insert returns no row', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresBulkUploadsStore();

    const result = await store.create(makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });

  it('returns DB_UNAVAILABLE when the driver throws', async () => {
    const db = makeFakeDb(() => {
      throw new Error('connection reset');
    });
    _setDbClients(null, db as never);
    const store = new PostgresBulkUploadsStore();

    const result = await store.create(makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
    expect(result.error.message).toContain('connection reset');
  });
});

// ─── findById / findByAggregatorAndEtag ────────────────────────────────────

describe('PostgresBulkUploadsStore.findById', () => {
  it('returns the mapped row scoped to the aggregator', async () => {
    const db = makeFakeDb(() => [makeRow({ id: 'upload-1' })]);
    _setDbClients(null, db as never);
    const store = new PostgresBulkUploadsStore();

    const result = await store.findById('upload-1', 'agg-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value?.id).toBe('upload-1');
  });

  it('returns null when not found', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresBulkUploadsStore();

    const result = await store.findById('missing', 'agg-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it('returns DB_UNAVAILABLE when the driver throws', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresBulkUploadsStore();

    const result = await store.findById('upload-1', 'agg-1');
    expect(result.ok).toBe(false);
  });
});

describe('PostgresBulkUploadsStore.findByAggregatorAndEtag', () => {
  it('returns the mapped row when an existing upload has the etag', async () => {
    const db = makeFakeDb(() => [makeRow({ s3Etag: 'etag-1' })]);
    _setDbClients(null, db as never);
    const store = new PostgresBulkUploadsStore();

    const result = await store.findByAggregatorAndEtag('agg-1', 'etag-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value?.s3Etag).toBe('etag-1');
  });

  it('returns null when no upload matches', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresBulkUploadsStore();

    const result = await store.findByAggregatorAndEtag('agg-1', 'missing-etag');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it('returns DB_UNAVAILABLE when the driver throws', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresBulkUploadsStore();

    const result = await store.findByAggregatorAndEtag('agg-1', 'etag-1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });
});

// ─── list ───────────────────────────────────────────────────────────────────

describe('PostgresBulkUploadsStore.list', () => {
  it('returns rows + total scoped to the aggregator', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      if (hasCall(chain, 'orderBy')) {
        captured = chain;
        return [makeRow({ id: 'u1' }), makeRow({ id: 'u2' })];
      }
      return [{ count: 2 }];
    });
    _setDbClients(null, db as never);
    const store = new PostgresBulkUploadsStore();

    const result = await store.list('agg-1', { limit: 10, offset: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows).toHaveLength(2);
    expect(result.value.total).toBe(2);
    expect(callArgs(captured, 'limit')).toEqual([10]);
    expect(callArgs(captured, 'offset')).toEqual([0]);
  });

  it('defaults total to 0 when the count query returns no row', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresBulkUploadsStore();

    const result = await store.list('agg-1', { limit: 10, offset: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(0);
  });

  it('returns DB_UNAVAILABLE when the driver throws', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresBulkUploadsStore();

    const result = await store.list('agg-1', { limit: 10, offset: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });
});

// ─── deletePending ──────────────────────────────────────────────────────────

describe('PostgresBulkUploadsStore.deletePending', () => {
  it('returns ok(void) on success, scoping the delete to status=pending', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      captured = chain;
      return [];
    });
    _setDbClients(null, db as never);
    const store = new PostgresBulkUploadsStore();

    const result = await store.deletePending('upload-1', 'agg-1');
    expect(result.ok).toBe(true);
    expect(hasCall(captured, 'where')).toBe(true);
  });

  it('returns DB_UNAVAILABLE when the driver throws', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresBulkUploadsStore();

    const result = await store.deletePending('upload-1', 'agg-1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });
});

// ─── markUploaded ───────────────────────────────────────────────────────────

describe('PostgresBulkUploadsStore.markUploaded', () => {
  it('transitions pending -> uploaded and stamps the etag', async () => {
    let updateChain: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      if (hasCall(chain, 'update')) {
        updateChain = chain;
        return [makeRow({ status: 'uploaded', s3Etag: 'etag-1' })];
      }
      // findById lookup — currently pending.
      return [makeRow({ status: 'pending' })];
    });
    _setDbClients(null, db as never);
    const store = new PostgresBulkUploadsStore();

    const result = await store.markUploaded('upload-1', 'agg-1', 'etag-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('uploaded');
    expect(callArgs(updateChain, 'set')?.[0]).toMatchObject({
      status: 'uploaded',
      s3Etag: 'etag-1',
    });
  });

  it('propagates the error result when the findById lookup fails', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresBulkUploadsStore();

    const result = await store.markUploaded('upload-1', 'agg-1', 'etag-1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });

  it('returns NOT_FOUND when the upload row does not exist', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresBulkUploadsStore();

    const result = await store.markUploaded('missing', 'agg-1', 'etag-1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('returns INVALID_TRANSITION when the row is already past uploaded', async () => {
    const db = makeFakeDb(() => [makeRow({ status: 'completed' })]);
    _setDbClients(null, db as never);
    const store = new PostgresBulkUploadsStore();

    const result = await store.markUploaded('upload-1', 'agg-1', 'etag-1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_TRANSITION');
  });

  it('is idempotent: re-marking uploaded with the same etag is a no-op success', async () => {
    const db = makeFakeDb(() => [makeRow({ status: 'uploaded', s3Etag: 'etag-1' })]);
    _setDbClients(null, db as never);
    const store = new PostgresBulkUploadsStore();

    const result = await store.markUploaded('upload-1', 'agg-1', 'etag-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('uploaded');
  });

  it('re-attempts the write when already uploaded with a different etag', async () => {
    let updateChain: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      if (hasCall(chain, 'update')) {
        updateChain = chain;
        return [makeRow({ status: 'uploaded', s3Etag: 'etag-2' })];
      }
      return [makeRow({ status: 'uploaded', s3Etag: 'etag-1' })];
    });
    _setDbClients(null, db as never);
    const store = new PostgresBulkUploadsStore();

    const result = await store.markUploaded('upload-1', 'agg-1', 'etag-2');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.s3Etag).toBe('etag-2');
    expect(hasCall(updateChain, 'update')).toBe(true);
  });

  it('returns INVALID_TRANSITION when the row raced past pending/uploaded between read and write', async () => {
    const db = makeFakeDb((chain) => {
      if (hasCall(chain, 'update')) return [];
      return [makeRow({ status: 'pending' })];
    });
    _setDbClients(null, db as never);
    const store = new PostgresBulkUploadsStore();

    const result = await store.markUploaded('upload-1', 'agg-1', 'etag-1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_TRANSITION');
  });

  it('maps a unique violation on the write to DUPLICATE_ETAG', async () => {
    const db = makeFakeDb((chain) => {
      if (hasCall(chain, 'update')) {
        throw Object.assign(new Error('duplicate'), { code: '23505' });
      }
      return [makeRow({ status: 'pending' })];
    });
    _setDbClients(null, db as never);
    const store = new PostgresBulkUploadsStore();

    const result = await store.markUploaded('upload-1', 'agg-1', 'etag-1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DUPLICATE_ETAG');
  });

  it('maps any other write error to DB_UNAVAILABLE', async () => {
    const db = makeFakeDb((chain) => {
      if (hasCall(chain, 'update')) throw new Error('connection reset');
      return [makeRow({ status: 'pending' })];
    });
    _setDbClients(null, db as never);
    const store = new PostgresBulkUploadsStore();

    const result = await store.markUploaded('upload-1', 'agg-1', 'etag-1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });
});
