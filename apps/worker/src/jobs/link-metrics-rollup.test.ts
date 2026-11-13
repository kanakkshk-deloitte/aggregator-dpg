/**
 * Unit tests for the Link Metrics Coordinator rollup job.
 *
 * `rollupLinkMetrics` reads unrolled `link_submissions` rows, aggregates them
 * into hourly (aggregator, link, hour) buckets, UPSERTs each bucket into
 * `onboarding`, and finally marks every picked-up submission rolled up. All
 * DB access goes through a hand-built chainable Drizzle stub — no real
 * Postgres. Per `apps/worker/CLAUDE.md`, steps 3 (bucket upserts) and 4 (mark
 * rolled-up) are NOT wrapped in a single transaction in the current
 * implementation, so a crash between them re-processes the same rows on the
 * next run and double-counts. These tests exercise the actual (non-atomic)
 * behaviour — they do not assert atomicity that doesn't exist, and this file
 * does not modify `link-metrics-rollup.ts` to add one.
 *
 * @module @aggregator-dpg/worker
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── DB fake ─────────────────────────────────────────────────────────────────

interface SelectRow {
  id: string;
  linkId: string;
  aggregatorId: string;
  orgSlug: string;
  outcome: 'passed' | 'failed' | 'skipped';
  createdAt: Date;
}

let selectRows: SelectRow[] = [];
let selectShouldThrow: Error | null = null;
let updateShouldThrow: Error | null = null;
const insertValues: Array<Record<string, unknown>> = [];
const onConflictOpts: Array<Record<string, unknown>> = [];
const updateSets: Array<Record<string, unknown>> = [];
const updateWhereConds: unknown[] = [];

function makeDb() {
  // Each getDb() call gets its own chain; a `mode` flag set by the first verb
  // routes `.values()`/`.set()` to the right bucket without needing separate
  // chain shapes per statement type (mirrors the pattern in
  // bulk-file-process.test.ts's makeDb()).
  let mode: 'select' | 'insert' | 'update' | null = null;
  const chain: Record<string, unknown> = {};
  chain['select'] = () => {
    mode = 'select';
    return chain;
  };
  chain['from'] = () => chain;
  chain['innerJoin'] = () => chain;
  chain['orderBy'] = () => chain;
  chain['where'] = (cond: unknown) => {
    if (mode === 'update') updateWhereConds.push(cond);
    return chain;
  };
  chain['limit'] = async () => {
    if (selectShouldThrow) throw selectShouldThrow;
    return selectRows;
  };
  chain['insert'] = () => {
    mode = 'insert';
    return chain;
  };
  chain['values'] = (v: Record<string, unknown>) => {
    insertValues.push(v);
    return chain;
  };
  chain['onConflictDoUpdate'] = async (opts: Record<string, unknown>) => {
    onConflictOpts.push(opts);
    return undefined;
  };
  chain['update'] = () => {
    mode = 'update';
    return chain;
  };
  chain['set'] = (v: Record<string, unknown>) => {
    updateSets.push(v);
    return chain;
  };
  chain['then'] = (resolve: (v: unknown) => void) => {
    if (updateShouldThrow) throw updateShouldThrow;
    resolve(undefined);
  };
  return chain;
}

vi.mock('../db.js', () => ({
  getDb: () => makeDb(),
  schema: {
    linkSubmissions: {
      id: 'id',
      linkId: 'linkId',
      userId: 'userId',
      outcome: 'outcome',
      createdAt: 'createdAt',
      rolledUpAt: 'rolledUpAt',
    },
    users: { id: 'id', signalstackOrgSlug: 'signalstackOrgSlug' },
    onboarding: {
      userId: 'userId',
      linkId: 'linkId',
      periodStart: 'periodStart',
      total: 'total',
      passed: 'passed',
      failed: 'failed',
      skipped: 'skipped',
    },
  },
}));

vi.mock('../config.js', () => ({
  config: { LOG_LEVEL: 'silent', NODE_ENV: 'test' },
}));

const { rollupLinkMetrics } = await import('./link-metrics-rollup.js');

function row(overrides: Partial<SelectRow>): SelectRow {
  return {
    id: 'sub-default',
    linkId: 'link-1',
    aggregatorId: 'agg-1',
    orgSlug: 'org-1',
    outcome: 'passed',
    createdAt: new Date('2024-01-01T10:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  selectRows = [];
  selectShouldThrow = null;
  updateShouldThrow = null;
  insertValues.length = 0;
  onConflictOpts.length = 0;
  updateSets.length = 0;
  updateWhereConds.length = 0;
});

describe('rollupLinkMetrics — edge case: nothing to do', () => {
  it('returns idle without touching insert/update when there are no unrolled submissions', async () => {
    const res = await rollupLinkMetrics({ tick: Date.now() });
    expect(res).toEqual({ status: 'idle', submissions: 0, buckets: 0 });
    expect(insertValues).toHaveLength(0);
    expect(updateSets).toHaveLength(0);
  });
});

describe('rollupLinkMetrics — normal execution', () => {
  it('aggregates by (aggregator, link, hour-bucket) and marks all picked-up rows rolled up', async () => {
    selectRows = [
      row({
        id: 's1',
        linkId: 'link-1',
        outcome: 'passed',
        createdAt: new Date('2024-01-01T10:15:00Z'),
      }),
      row({
        id: 's2',
        linkId: 'link-1',
        outcome: 'failed',
        createdAt: new Date('2024-01-01T10:45:00Z'),
      }),
      // Different hour -> separate bucket even though same link.
      row({
        id: 's3',
        linkId: 'link-1',
        outcome: 'skipped',
        createdAt: new Date('2024-01-01T11:05:00Z'),
      }),
      // Different link, same hour as s1/s2 -> separate bucket.
      row({
        id: 's4',
        linkId: 'link-2',
        outcome: 'passed',
        createdAt: new Date('2024-01-01T10:20:00Z'),
      }),
    ];

    const res = await rollupLinkMetrics({ tick: Date.now() });

    expect(res).toEqual({ status: 'rolled_up', submissions: 4, buckets: 3 });
    expect(insertValues).toHaveLength(3);

    const link1Hour10 = insertValues.find(
      (v) =>
        v['linkId'] === 'link-1' &&
        (v['periodStart'] as Date).toISOString().startsWith('2024-01-01T10:00'),
    );
    expect(link1Hour10).toMatchObject({
      source: 'link',
      userId: 'agg-1',
      signalstackOrgSlug: 'org-1',
      total: 2,
      passed: 1,
      failed: 1,
      skipped: 0,
    });

    const link1Hour11 = insertValues.find(
      (v) =>
        v['linkId'] === 'link-1' &&
        (v['periodStart'] as Date).toISOString().startsWith('2024-01-01T11:00'),
    );
    expect(link1Hour11).toMatchObject({ total: 1, passed: 0, failed: 0, skipped: 1 });

    const link2 = insertValues.find((v) => v['linkId'] === 'link-2');
    expect(link2).toMatchObject({ total: 1, passed: 1, failed: 0, skipped: 0 });

    // Every bucket goes through the increment-on-conflict upsert.
    expect(onConflictOpts).toHaveLength(3);

    // Final mark-rolled-up update happened exactly once, covering all 4 ids.
    expect(updateSets).toHaveLength(1);
    expect(updateSets[0]!['rolledUpAt']).toBeInstanceOf(Date);
    expect(updateWhereConds).toHaveLength(1);
  });

  it('computes periodEnd as exactly one hour after the bucket start', async () => {
    selectRows = [row({ createdAt: new Date('2024-06-01T05:30:00Z') })];
    await rollupLinkMetrics({ tick: Date.now() });
    const inserted = insertValues[0]!;
    const start = inserted['periodStart'] as Date;
    const end = inserted['periodEnd'] as Date;
    expect(start.toISOString()).toBe('2024-06-01T05:00:00.000Z');
    expect(end.getTime() - start.getTime()).toBe(60 * 60 * 1000);
  });
});

describe('rollupLinkMetrics — failure scenarios', () => {
  it('propagates a DB read failure without processing any bucket', async () => {
    selectShouldThrow = new Error('pg connection reset');
    await expect(rollupLinkMetrics({ tick: Date.now() })).rejects.toThrow('pg connection reset');
    expect(insertValues).toHaveLength(0);
  });

  it('documents the known non-atomic gap: an upsert can commit before a later failure prevents rolled_up_at from being set', async () => {
    // Per apps/worker/CLAUDE.md: steps 3 (bucket upsert) and 4 (mark
    // rolled-up) are separate statements, not wrapped in db.transaction().
    // Simulate a crash on the final mark-rolled-up write, after the bucket
    // upsert has already been issued — the bug is that the upsert is not
    // rolled back, so a retry against the same unrolled rows re-increments
    // the same onboarding totals a second time.
    selectRows = [row({ id: 's1' })];
    updateShouldThrow = new Error('connection lost before mark-rolled-up');

    await expect(rollupLinkMetrics({ tick: Date.now() })).rejects.toThrow(
      'connection lost before mark-rolled-up',
    );

    // The onboarding upsert for this bucket already went out — this is
    // exactly the non-atomicity the CLAUDE.md note warns about, not a bug
    // this test suite introduces or asserts should be fixed here.
    expect(insertValues).toHaveLength(1);
    expect(onConflictOpts).toHaveLength(1);
  });
});
