/**
 * Unit tests for {@link PostgresCampaignJobStore}.
 *
 * The Drizzle client (`getDb()`) is swapped for a hand-built thenable
 * query-builder stub (per testing.md §1 — third-party adapters may be stubbed).
 * Every chained call returns a thenable that resolves to the next canned result
 * in a per-test queue, and `.transaction(cb)` invokes the callback with the same
 * stub — this exercises the real create/idempotency/derived-count/cursor logic
 * in `postgres.ts` without a live database. Behavioural correctness is pinned
 * separately by the live-DB conformance suite (`postgres.integration.test.ts`).
 *
 * @module @aggregator-dpg/api
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Thenable Drizzle stub ───────────────────────────────────────────────────
let results: unknown[] = [];
let idx = 0;
const sets: Array<Record<string, unknown>> = [];
const inserted: Array<Record<string, unknown>[]> = [];

function stub(): unknown {
  return new Proxy(function () {}, {
    get(_t, prop: string | symbol) {
      if (prop === 'then') {
        return (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
          Promise.resolve(results[idx++]).then(onOk, onErr);
      }
      if (prop === 'transaction') {
        return async (cb: (tx: unknown) => unknown) => cb(stub());
      }
      if (prop === 'set') {
        return (v: Record<string, unknown>) => {
          sets.push(v);
          return stub();
        };
      }
      if (prop === 'values') {
        return (v: Record<string, unknown> | Record<string, unknown>[]) => {
          inserted.push(Array.isArray(v) ? v : [v]);
          return stub();
        };
      }
      return () => stub();
    },
    apply() {
      return stub();
    },
  });
}

vi.mock('../../../db/client.js', () => ({ getDb: () => stub() }));
vi.mock('../../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { PostgresCampaignJobStore } = await import('../postgres.js');

function queue(...r: unknown[]): void {
  results = r;
  idx = 0;
}

const jobRow = {
  id: 'job-1',
  aggregatorId: 'agg-1',
  signalstackOrgId: 'org-1',
  channel: 'export',
  status: 'pending',
  idempotencyKey: null,
  metadata: [{ key: 'purpose', value: 'audit' }],
  content: {},
  requestedBy: 'u@x',
  requestId: null,
  errorReason: null,
  lastProgressAt: null,
  createdAt: new Date('2026-08-01T00:00:00Z'),
  updatedAt: new Date('2026-08-01T00:00:00Z'),
};

const baseInput = {
  aggregatorId: 'agg-1',
  signalstackOrgId: 'org-1',
  channel: 'export' as const,
  metadata: [{ key: 'purpose', value: 'audit' }],
  content: {},
  requestedBy: 'u@x',
  items: [{ itemId: 'a', action: null }],
};

describe('PostgresCampaignJobStore', () => {
  let store: InstanceType<typeof PostgresCampaignJobStore>;
  beforeEach(() => {
    store = new PostgresCampaignJobStore();
    sets.length = 0;
    inserted.length = 0;
  });
  afterEach(() => vi.clearAllMocks());

  it('createJob: inserts job + items and returns created:true', async () => {
    // insert job -> [row]; null-action items skip the dedup select, so the
    // next queued result is the item insert's `.returning()`.
    queue([jobRow], [{ itemId: 'a' }]);
    const r = await store.createJob(baseInput);
    expect(r.ok && r.value.created).toBe(true);
    expect(r.ok && r.value.job.id).toBe('job-1');
  });

  it('createJob: a non-null-action item already active elsewhere is inserted duplicate_active', async () => {
    const input = {
      ...baseInput,
      items: [
        { itemId: 'a', action: null },
        { itemId: 'dup', action: 'voice_call' },
      ],
    };
    queue(
      [jobRow], // insert job
      [{ itemId: 'dup' }], // dedup select: 'dup' already active elsewhere
      [{ itemId: 'a' }, { itemId: 'dup' }], // insert items (onConflictDoNothing) -> both land, no race
    );
    const r = await store.createJob(input);
    expect(r.ok && r.value.created).toBe(true);
    // insert #1 is the job row; insert #2 is the item batch.
    const itemValues = inserted[1]!;
    expect(itemValues.find((v) => v.itemId === 'a')?.status).toBe('pending');
    expect(itemValues.find((v) => v.itemId === 'dup')?.status).toBe('duplicate_active');
  });

  it('createJob: a race on the fresh insert reclassifies the item duplicate_active and retries', async () => {
    const input = {
      ...baseInput,
      items: [{ itemId: 'raced', action: 'voice_call' }],
    };
    queue(
      [jobRow], // insert job
      [], // dedup select: nothing active yet (per our pre-check)
      [], // insert items (onConflictDoNothing) -> conflicted, nothing returned (raced)
      undefined, // retry insert as duplicate_active
    );
    const r = await store.createJob(input);
    expect(r.ok && r.value.created).toBe(true);
    // insert #1 = job row, insert #2 = the fresh attempt, insert #3 = the retry.
    expect(inserted[2]![0]!.status).toBe('duplicate_active');
    expect(inserted[2]![0]!.itemId).toBe('raced');
  });

  it('createJob: idempotency conflict returns the original job, created:false', async () => {
    queue([], [jobRow]); // insert -> [] (conflict); select existing -> [row]
    const r = await store.createJob({ ...baseInput, idempotencyKey: 'k1' });
    expect(r.ok && r.value.created).toBe(false);
    expect(r.ok && r.value.job.id).toBe('job-1');
  });

  it('createJob: maps a thrown DB error to DB_UNAVAILABLE', async () => {
    queue(Promise.reject(new Error('boom'))); // the insert await rejects inside the txn
    const r = await store.createJob(baseInput);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe('DB_UNAVAILABLE');
  });

  it('countActiveJobs: returns the count', async () => {
    queue([{ n: 3 }]);
    const r = await store.countActiveJobs('org-1');
    expect(r.ok && r.value).toBe(3);
  });

  it('getJob: returns null when not found', async () => {
    queue([]); // select -> []
    const r = await store.getJob('nope', 'org-1');
    expect(r.ok && r.value).toBeNull();
  });

  it('getJob: returns the view with derived counts', async () => {
    queue([jobRow], [{ status: 'resolved', n: 2 }]); // job row; countItems groupBy
    const r = await store.getJob('job-1', 'org-1');
    expect(r.ok && r.value?.counts).toEqual({
      total: 2,
      pending: 0,
      resolved: 2,
      submitted: 0,
      sent: 0,
      skipped_not_owned: 0,
      skipped_no_contact: 0,
      duplicate_active: 0,
      failed: 0,
    });
  });

  it('getJobItems: null when the job is not owned', async () => {
    queue([]); // owner check -> []
    const r = await store.getJobItems('job-1', 'other');
    expect(r.ok && r.value).toBeNull();
  });

  it('getJobItems: returns mapped items when owned', async () => {
    queue(
      [{ id: 'job-1' }],
      [{ itemId: 'a', action: null, status: 'resolved', errorReason: null }],
    );
    const r = await store.getJobItems('job-1', 'org-1');
    expect(r.ok && r.value?.[0]?.itemId).toBe('a');
  });

  it('listJobs: returns a page + nextCursor when there is more', async () => {
    const rows = Array.from({ length: 2 }, (_, i) => ({ ...jobRow, id: `j${i}` }));
    queue(rows, []); // select page (limit+1=2 for limit 1) ; countsForJobs groupBy
    const r = await store.listJobs('org-1', { limit: 1 });
    expect(r.ok && r.value.jobs).toHaveLength(1);
    expect(r.ok && r.value.nextCursor).not.toBeNull();
  });

  it('listJobs: honours channel filter + cursor with no extra page', async () => {
    queue([jobRow], [{ jobId: 'job-1', status: 'resolved', n: 1 }]);
    const r = await store.listJobs('org-1', {
      channel: 'export',
      cursor: '2026-08-01T00:00:00.000Z__job-0',
    });
    expect(r.ok && r.value.nextCursor).toBeNull();
  });

  it('getJobForProcessing: returns null when absent', async () => {
    queue([]);
    const r = await store.getJobForProcessing('nope');
    expect(r.ok && r.value).toBeNull();
  });

  it('getJobForProcessing: returns the unscoped job + items', async () => {
    queue([jobRow], [{ itemId: 'a', action: null, status: 'pending', errorReason: null }]);
    const r = await store.getJobForProcessing('job-1');
    expect(r.ok && r.value?.signalstackOrgId).toBe('org-1');
    expect(r.ok && r.value?.items).toHaveLength(1);
  });

  it('countItems: tallies grouped rows', async () => {
    queue([
      { status: 'resolved', n: 2 },
      { status: 'failed', n: 1 },
    ]);
    const r = await store.countItems('job-1');
    expect(r.ok && r.value).toEqual({
      total: 3,
      pending: 0,
      resolved: 2,
      submitted: 0,
      sent: 0,
      skipped_not_owned: 0,
      skipped_no_contact: 0,
      duplicate_active: 0,
      failed: 1,
    });
  });

  it('markItem / heartbeat / setJobStatus issue updates', async () => {
    queue(undefined, undefined, undefined);
    expect((await store.markItem('job-1', 'a', 'resolved')).ok).toBe(true);
    expect((await store.heartbeat('job-1')).ok).toBe(true);
    expect((await store.setJobStatus('job-1', 'completed', 'done')).ok).toBe(true);
    expect(sets.some((s) => s.status === 'resolved')).toBe(true);
    expect(sets.some((s) => s.lastProgressAt instanceof Date)).toBe(true);
    expect(sets.some((s) => s.status === 'completed' && s.errorReason === 'done')).toBe(true);
  });

  it('markSubmitted: sets submitted + raya_batch_id (+ provider_ref when given)', async () => {
    queue(undefined);
    const r = await store.markSubmitted('job-1', 'a', {
      providerBatchRef: 'batch-1',
      providerRef: 'ref-1',
    });
    expect(r.ok).toBe(true);
    expect(
      // The Drizzle `.set()` payload uses the column-mapped field name
      // (`rayaBatchId`, unchanged) — the store-contract `providerBatchRef`
      // arg is mapped onto it by `markSubmitted`, not passed through verbatim.
      sets.some(
        (s) => s.status === 'submitted' && s.rayaBatchId === 'batch-1' && s.providerRef === 'ref-1',
      ),
    ).toBe(true);
  });

  it('markSubmitted: omits provider_ref from the update when not given', async () => {
    queue(undefined);
    await store.markSubmitted('job-1', 'a', { providerBatchRef: 'batch-2' });
    const set = sets.at(-1)!;
    expect(set.status).toBe('submitted');
    expect('providerRef' in set).toBe(false);
  });

  it('setProviderResponse: writes the raw payload', async () => {
    queue(undefined);
    const payload = { batchId: 'batch-1', status: 'accepted' };
    const r = await store.setProviderResponse('job-1', payload);
    expect(r.ok).toBe(true);
    expect(sets.some((s) => s.providerResponse === payload)).toBe(true);
  });

  it('markSubmitted: maps a thrown DB error to DB_UNAVAILABLE', async () => {
    queue(Promise.reject(new Error('connection reset')));
    const r = await store.markSubmitted('job-1', 'a', { providerBatchRef: 'batch-1' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe('DB_UNAVAILABLE');
  });

  it('setProviderResponse: maps a thrown DB error to DB_UNAVAILABLE', async () => {
    queue(Promise.reject(new Error('connection reset')));
    const r = await store.setProviderResponse('job-1', { any: 'payload' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe('DB_UNAVAILABLE');
  });

  it('rollUpStatus: derives + persists from counts', async () => {
    queue([{ status: 'resolved', n: 2 }], undefined); // countItems ; setJobStatus update
    const r = await store.rollUpStatus('job-1');
    expect(r.ok && r.value).toBe('completed');
  });

  it('claimStalledJobs: returns the stale ids', async () => {
    queue([{ id: 'job-1' }, { id: 'job-2' }]);
    const r = await store.claimStalledJobs(900);
    expect(r.ok && r.value).toEqual(['job-1', 'job-2']);
  });
});
