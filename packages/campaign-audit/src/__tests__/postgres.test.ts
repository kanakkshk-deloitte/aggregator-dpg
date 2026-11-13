import { describe, it, expect, vi } from 'vitest';
import { PostgresCampaignAuditWriter } from '../postgres.js';
import { buildRequestedAudit, buildCompletedAudit } from '../testing/index.js';

function stubDb() {
  const values = vi.fn().mockResolvedValue(undefined);
  return { db: { insert: () => ({ values }) } as never, values };
}

describe('PostgresCampaignAuditWriter', () => {
  it('writes a requested row with no outcome', async () => {
    const { db, values } = stubDb();
    await new PostgresCampaignAuditWriter(db).recordRequested(buildRequestedAudit());
    const row = values.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.event).toBe('requested');
    expect(row.outcome).toBeUndefined();
    expect(row.requestedCount).toBe(3);
  });

  it('writes a completed row carrying the org for single-scan org queries', async () => {
    const { db, values } = stubDb();
    await new PostgresCampaignAuditWriter(db).recordCompleted(buildCompletedAudit());
    const row = values.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.event).toBe('completed');
    expect(row.actorSignalstackOrgId).toBe('org_test');
    expect(row.outcome).toBe('succeeded');
  });

  it('returns an err Result instead of throwing when the insert fails', async () => {
    const values = vi.fn().mockRejectedValue(new Error('db down'));
    const db = { insert: () => ({ values }) } as never;
    const r = await new PostgresCampaignAuditWriter(db).recordRequested(buildRequestedAudit());
    expect(r.success).toBe(false);
  });
});

describe('PostgresCampaignAuditWriter — statement timeout (#617 SHOULD-FIX 1)', () => {
  it('inserts directly (no transaction) when no statementTimeoutMs is configured', async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    const transaction = vi.fn();
    const db = { insert: () => ({ values }), transaction } as never;
    await new PostgresCampaignAuditWriter(db).recordRequested(buildRequestedAudit());
    expect(transaction).not.toHaveBeenCalled();
    expect(values).toHaveBeenCalledTimes(1);
  });

  it('wraps the insert in a transaction and sets SET LOCAL statement_timeout first', async () => {
    const calls: string[] = [];
    const execute = vi.fn().mockImplementation(async (query: { queryChunks?: unknown }) => {
      calls.push('execute');
      // Prove the actual bound value is what was configured, not hardcoded.
      expect(JSON.stringify(query)).toContain('2000ms');
    });
    const values = vi.fn().mockImplementation(async () => {
      calls.push('insert');
    });
    const tx = { execute, insert: () => ({ values }) };
    const transaction = vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      await fn(tx);
    });
    const db = { insert: vi.fn(), transaction } as never;

    const result = await new PostgresCampaignAuditWriter(db, 2000).recordRequested(
      buildRequestedAudit(),
    );

    expect(result.success).toBe(true);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    // SET LOCAL statement_timeout must run BEFORE the insert, in the same
    // transaction, or the bound would not cover the query it's meant to guard.
    expect(calls).toEqual(['execute', 'insert']);
  });

  it(
    'releases the connection at (or before) the configured bound when the query stalls — ' +
      'proving the transaction wrapper, not a bare Promise.race, is what frees a stuck connection',
    async () => {
      vi.useFakeTimers();
      try {
        let connectionHeld = false;
        const STATEMENT_TIMEOUT_MS = 2000;

        // Models what a real Postgres `SET LOCAL statement_timeout` does: the
        // in-flight query is canceled (its promise rejects) once the bound
        // elapses, which is what actually returns the connection to the pool.
        // A JS-only `Promise.race` around the writer call could never do
        // this — it would abandon the caller's await but leave the query (and
        // its checked-out connection) running underneath indefinitely.
        const tx = {
          execute: vi.fn().mockResolvedValue(undefined),
          insert: () => ({
            values: () =>
              new Promise((_resolve, reject) => {
                setTimeout(() => {
                  reject(new Error('canceling statement due to statement timeout'));
                }, STATEMENT_TIMEOUT_MS);
              }),
          }),
        };
        const db = {
          insert: vi.fn(),
          transaction: async <T>(fn: (tx: unknown) => Promise<T>) => {
            connectionHeld = true;
            try {
              return await fn(tx);
            } finally {
              connectionHeld = false;
            }
          },
        } as never;

        const writer = new PostgresCampaignAuditWriter(db, STATEMENT_TIMEOUT_MS);
        const pending = writer.recordRequested(buildRequestedAudit());

        // Just before the bound: the query is still "running" and the
        // connection is still checked out — this is the state a bare
        // Promise.race would leave forever on a genuine DB-side stall.
        await vi.advanceTimersByTimeAsync(STATEMENT_TIMEOUT_MS - 1);
        expect(connectionHeld).toBe(true);

        // At the bound: Postgres cancels the statement, the transaction
        // settles (with an error), and the connection is released.
        await vi.advanceTimersByTimeAsync(1);
        const result = await pending;

        expect(connectionHeld).toBe(false);
        expect(result.success).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
