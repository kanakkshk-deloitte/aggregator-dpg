import { describe, it, expect } from 'vitest';
import type pg from 'pg';
import { DATA_STEPS, runDataSteps, type DataStep } from '../instance-upgrade-data.js';

/** A fake pool whose one client records the queries it was issued. */
function fakePool(): { pool: pg.Pool; queries: string[]; released: () => boolean } {
  const queries: string[] = [];
  let released = false;
  const client = {
    query: async (q: string) => {
      queries.push(q);
      return { rows: [] };
    },
    release: () => {
      released = true;
    },
  };
  const pool = { connect: async () => client } as unknown as pg.Pool;
  return { pool, queries, released: () => released };
}

const lines: (sink: string[]) => (l: string) => void = (sink) => (l) => sink.push(l);

describe('runDataSteps', () => {
  it('is a success no-op when the registry is empty (never opens a transaction)', async () => {
    const out: string[] = [];
    const { pool, queries } = fakePool();
    const code = await runDataSteps(pool, [], { dryRun: false }, lines(out));
    expect(code).toBe(0);
    expect(out).toEqual(['data: no standalone data steps in this release']);
    expect(queries).toEqual([]); // no connect/BEGIN for an empty run
  });

  it('applies each step, verifies, and commits', async () => {
    const out: string[] = [];
    const { pool, queries, released } = fakePool();
    const applied: string[] = [];
    const steps: DataStep[] = [
      { name: 'a', apply: async () => void applied.push('a') },
      { name: 'b', apply: async () => void applied.push('b'), verify: async () => 0 },
    ];
    const code = await runDataSteps(pool, steps, { dryRun: false }, lines(out));
    expect(code).toBe(0);
    expect(applied).toEqual(['a', 'b']);
    expect(queries[0]).toBe('BEGIN');
    expect(queries.at(-1)).toBe('COMMIT');
    expect(out.at(-1)).toContain('COMMITTED 2 step(s)');
    expect(released()).toBe(true);
  });

  it('rolls back and fails when a verify finds wrong rows', async () => {
    const out: string[] = [];
    const { pool, queries } = fakePool();
    const steps: DataStep[] = [
      { name: 'bad', apply: async () => undefined, verify: async () => 3 },
    ];
    const code = await runDataSteps(pool, steps, { dryRun: false }, lines(out));
    expect(code).toBe(1);
    expect(queries).toContain('ROLLBACK');
    expect(queries).not.toContain('COMMIT');
    expect(out.at(-1)).toContain('verify failed (3)');
  });

  it('applies then rolls back on --dry-run', async () => {
    const out: string[] = [];
    const { pool, queries } = fakePool();
    const steps: DataStep[] = [{ name: 'a', apply: async () => undefined }];
    const code = await runDataSteps(pool, steps, { dryRun: true }, lines(out));
    expect(code).toBe(0);
    expect(queries.at(-1)).toBe('ROLLBACK');
    expect(out.at(-1)).toContain('DRY RUN');
  });

  it('rolls back and fails when a step throws', async () => {
    const out: string[] = [];
    const { pool, queries } = fakePool();
    const steps: DataStep[] = [
      {
        name: 'boom',
        apply: async () => {
          throw Object.assign(new Error('x'), { code: '23505' });
        },
      },
    ];
    const code = await runDataSteps(pool, steps, { dryRun: false }, lines(out));
    expect(code).toBe(1);
    expect(queries).toContain('ROLLBACK');
    expect(out.at(-1)).toContain('FAILED');
  });

  it('ships no standalone steps this release (0027–0029 data is schema-coupled)', () => {
    expect(DATA_STEPS).toEqual([]);
  });
});
