/**
 * Unit tests for the worker's Drizzle Postgres singleton.
 *
 * `pg.Pool` and `drizzle()` are mocked so no real database connection is
 * attempted — only the singleton wiring (lazy construction, caching,
 * teardown) is under test.
 *
 * @module @aggregator-dpg/worker
 */

import { describe, it, expect, vi } from 'vitest';

const poolInstances: Array<{ opts: unknown; end: ReturnType<typeof vi.fn> }> = [];

vi.mock('pg', () => {
  class FakePool {
    opts: unknown;
    end = vi.fn(async () => undefined);
    constructor(opts: unknown) {
      this.opts = opts;
      poolInstances.push(this);
    }
  }
  return { default: { Pool: FakePool } };
});

const drizzleCalls: Array<{ pool: unknown; opts: unknown }> = [];
vi.mock('drizzle-orm/node-postgres', () => ({
  drizzle: vi.fn((pool: unknown, opts: unknown) => {
    const built = { __fakeDb: true, pool, opts };
    drizzleCalls.push(built);
    return built;
  }),
}));

vi.mock('./config.js', () => ({
  config: { DATABASE_URL: 'postgres://worker-test:5432/db' },
}));

const { getDb, closeDb, _setDb, schema } = await import('./db.js');

describe('worker db singleton', () => {
  it('re-exports the drizzle schema', () => {
    expect(schema).toBeDefined();
  });

  it('lazily constructs a pool + drizzle db on first getDb() call', () => {
    const db = getDb();
    expect(poolInstances).toHaveLength(1);
    expect(poolInstances[0]?.opts).toEqual({ connectionString: 'postgres://worker-test:5432/db' });
    expect(drizzleCalls).toHaveLength(1);
    expect(db).toBe(drizzleCalls[0]);
    expect((db as unknown as { pool: unknown }).pool).toBe(poolInstances[0]);
  });

  it('caches the db instance — a second call reuses the same pool/db (no new Pool/drizzle() call)', () => {
    const poolCountBefore = poolInstances.length;
    const drizzleCountBefore = drizzleCalls.length;
    const first = getDb();
    const second = getDb();
    expect(second).toBe(first);
    expect(poolInstances).toHaveLength(poolCountBefore);
    expect(drizzleCalls).toHaveLength(drizzleCountBefore);
  });

  it('closeDb() ends the pool and resets the singleton so the next getDb() rebuilds it', async () => {
    const before = getDb();
    const activePool = poolInstances[poolInstances.length - 1];
    const poolCountBefore = poolInstances.length;

    await closeDb();
    expect(activePool?.end).toHaveBeenCalledOnce();

    const after = getDb();
    expect(after).not.toBe(before);
    expect(poolInstances).toHaveLength(poolCountBefore + 1);
  });

  it('closeDb() is idempotent — calling it again with no pending pool does not throw', async () => {
    await closeDb();
    await expect(closeDb()).resolves.toBeUndefined();
  });

  it('_setDb injects a fake db instance so getDb() returns it without touching the pool', () => {
    const poolCountBefore = poolInstances.length;
    const fake = { __injected: true } as unknown as ReturnType<typeof getDb>;
    _setDb(fake);
    expect(getDb()).toBe(fake);
    expect(poolInstances).toHaveLength(poolCountBefore);
    _setDb(null);
  });
});
