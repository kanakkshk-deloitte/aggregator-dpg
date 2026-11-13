/**
 * Unit tests for the worker-side campaign job client.
 *
 * `getDb()` is swapped for a thenable Drizzle stub (per testing.md §1) whose
 * chained calls resolve to a per-test queue of canned results; behavioural
 * correctness against a real DB is pinned by the API store's conformance suite.
 *
 * @module @aggregator-dpg/worker
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let results: unknown[] = [];
let idx = 0;
const sets: Array<Record<string, unknown>> = [];

function stub(): unknown {
  return new Proxy(function () {}, {
    get(_t, prop: string | symbol) {
      if (prop === 'then') {
        return (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
          Promise.resolve(results[idx++]).then(onOk, onErr);
      }
      if (prop === 'set') {
        return (v: Record<string, unknown>) => {
          sets.push(v);
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

vi.mock('../db.js', () => ({ getDb: () => stub() }));

const client = await import('./campaign-job-client.js');

function queue(...r: unknown[]): void {
  results = r;
  idx = 0;
}

const jobRow = {
  id: 'job-1',
  channel: 'export',
  status: 'processing',
  signalstackOrgId: 'org-1',
  metadata: [{ key: 'purpose', value: 'audit' }],
  content: {},
  requestedBy: 'u@x',
  requestId: null,
};

describe('deriveJobStatus', () => {
  it('maps counts to the roll-up status', () => {
    expect(
      client.deriveJobStatus({
        total: 0,
        pending: 0,
        resolved: 0,
        submitted: 0,
        sent: 0,
        skipped_not_owned: 0,
        skipped_no_contact: 0,
        duplicate_active: 0,
        failed: 0,
      }),
    ).toBe('completed');
    expect(
      client.deriveJobStatus({
        total: 2,
        pending: 1,
        resolved: 1,
        submitted: 0,
        sent: 0,
        skipped_not_owned: 0,
        skipped_no_contact: 0,
        duplicate_active: 0,
        failed: 0,
      }),
    ).toBe('processing');
    expect(
      client.deriveJobStatus({
        total: 2,
        pending: 0,
        resolved: 2,
        submitted: 0,
        sent: 0,
        skipped_not_owned: 0,
        skipped_no_contact: 0,
        duplicate_active: 0,
        failed: 0,
      }),
    ).toBe('completed');
    expect(
      client.deriveJobStatus({
        total: 2,
        pending: 0,
        resolved: 0,
        submitted: 0,
        sent: 0,
        skipped_not_owned: 0,
        skipped_no_contact: 0,
        duplicate_active: 0,
        failed: 2,
      }),
    ).toBe('failed');
    expect(
      client.deriveJobStatus({
        total: 2,
        pending: 0,
        resolved: 1,
        submitted: 0,
        sent: 0,
        skipped_not_owned: 0,
        skipped_no_contact: 0,
        duplicate_active: 0,
        failed: 1,
      }),
    ).toBe('partial');
  });
});

describe('campaign job client', () => {
  beforeEach(() => {
    sets.length = 0;
  });
  afterEach(() => vi.clearAllMocks());

  it('getJobForProcessing returns null when absent', async () => {
    queue([]);
    expect(await client.getJobForProcessing('nope')).toBeNull();
  });

  it('getJobForProcessing returns the job + items', async () => {
    queue([jobRow], [{ itemId: 'a', action: null, status: 'pending' }]);
    const job = await client.getJobForProcessing('job-1');
    expect(job?.signalstackOrgId).toBe('org-1');
    expect(job?.items).toHaveLength(1);
  });

  it('countItems tallies grouped rows', async () => {
    queue([
      { status: 'resolved', n: 3 },
      { status: 'failed', n: 1 },
    ]);
    expect(await client.countItems('job-1')).toEqual({
      total: 4,
      pending: 0,
      resolved: 3,
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
    await client.markItem('job-1', 'a', 'failed', 'not owned');
    await client.heartbeat('job-1');
    await client.setJobStatus('job-1', 'failed', 'stalled');
    expect(sets.some((s) => s.status === 'failed' && s.errorReason === 'not owned')).toBe(true);
    expect(sets.some((s) => s.lastProgressAt instanceof Date)).toBe(true);
    expect(sets.some((s) => s.status === 'failed' && s.errorReason === 'stalled')).toBe(true);
  });

  it('markItem routes a skip reason to skip_reason, never error_reason', async () => {
    queue(undefined);
    await client.markItem('job-1', 'b', 'skipped_not_owned', 'not_owned_by_org');
    expect(sets.some((s) => s.skipReason === 'not_owned_by_org' && s.errorReason === null)).toBe(
      true,
    );
    // and it stamps a completion time, since a skip is terminal
    expect(sets.some((s) => s.completedAt instanceof Date)).toBe(true);
  });

  it('markSubmitted sets submitted + raya_batch_id (+ provider_ref when given)', async () => {
    queue(undefined);
    await client.markSubmitted('job-1', 'a', { providerBatchRef: 'batch-1', providerRef: 'ref-1' });
    expect(
      // The Drizzle `.set()` payload uses the column-mapped field name
      // (`rayaBatchId`, unchanged) — `markSubmitted`'s `providerBatchRef` arg
      // is mapped onto it, not passed through verbatim.
      sets.some(
        (s) => s.status === 'submitted' && s.rayaBatchId === 'batch-1' && s.providerRef === 'ref-1',
      ),
    ).toBe(true);
  });

  it('markSubmitted omits provider_ref from the update when not given', async () => {
    queue(undefined);
    await client.markSubmitted('job-1', 'a', { providerBatchRef: 'batch-2' });
    const set = sets.at(-1)!;
    expect(set.status).toBe('submitted');
    expect('providerRef' in set).toBe(false);
  });

  it('setProviderResponse writes the raw payload', async () => {
    queue(undefined);
    const payload = { batchId: 'batch-1', status: 'accepted' };
    await client.setProviderResponse('job-1', payload);
    expect(sets.some((s) => s.providerResponse === payload)).toBe(true);
  });

  it('rollUpStatus derives + persists, returning both the status and the counts it derived from', async () => {
    queue([{ status: 'resolved', n: 2 }], undefined);
    const result = await client.rollUpStatus('job-1');
    expect(result.status).toBe('completed');
    expect(result.counts).toMatchObject({ total: 2, resolved: 2 });
  });

  it('toAuditCounts aggregates the three skip statuses into skippedCount', () => {
    const counts = {
      total: 6,
      pending: 0,
      resolved: 1,
      submitted: 0,
      sent: 1,
      skipped_not_owned: 1,
      skipped_no_contact: 1,
      duplicate_active: 1,
      failed: 1,
    };
    expect(client.toAuditCounts(counts)).toEqual({
      resolvedCount: 1,
      skippedCount: 3,
      failedCount: 1,
      sentCount: 1,
    });
  });

  it('toAuditCounts rolls submitted (voice: handed to the provider) into resolvedCount, not sentCount', () => {
    // A fully successful voice job: every item terminates at `submitted`,
    // never `resolved` or `sent`. Before this fix, `resolvedCount` would be
    // computed from `resolved` alone and every count would land at zero —
    // indistinguishable from "nothing happened" even though every contact
    // was handed to Raya.
    const counts = {
      total: 3,
      pending: 0,
      resolved: 0,
      submitted: 3,
      sent: 0,
      skipped_not_owned: 0,
      skipped_no_contact: 0,
      duplicate_active: 0,
      failed: 0,
    };
    expect(client.toAuditCounts(counts)).toEqual({
      resolvedCount: 3,
      skippedCount: 0,
      failedCount: 0,
      sentCount: 0,
    });
  });

  it('claimStalledJobs returns ids', async () => {
    queue([{ id: 'job-1' }]);
    expect(await client.claimStalledJobs(900)).toEqual(['job-1']);
  });
});
