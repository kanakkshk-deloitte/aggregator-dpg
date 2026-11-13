/**
 * Unit tests for the shared Postgres pool / Drizzle client singleton.
 *
 * `pg.Pool` is lazy — constructing one (and calling `.end()` on one with no
 * active connections) does not open a real socket, so these tests exercise
 * the real `getPool()` / `getDb()` / `closeDb()` logic without a live
 * database, per testing-requirements.md (no real DB/network calls). State is
 * reset via the test-only `_setDbClients` hook between tests so the module
 * singleton doesn't leak across cases.
 *
 * @module @aggregator-dpg/api
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError } from '@aggregator-dpg/shared-primitives/errors';
import { _setDbClients, closeDb, getDb, getPool } from '../client.js';

afterEach(async () => {
  // Best-effort: close whatever pool the test left behind, then clear the
  // singleton so the next test starts clean.
  await closeDb().catch(() => undefined);
  _setDbClients(null, null);
});

describe('getPool', () => {
  it('creates a pool from DATABASE_URL when no override is given', () => {
    const pool = getPool();
    expect(pool.options.connectionString).toBe(process.env.DATABASE_URL);
    expect(pool.options.max).toBe(10);
    expect(pool.options.idleTimeoutMillis).toBe(10_000);
    expect(pool.options.connectionTimeoutMillis).toBe(5_000);
  });

  it('throws ConfigError when neither an override nor DATABASE_URL is available', () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect(() => getPool()).toThrow(ConfigError);
      expect(() => getPool()).toThrow(/DATABASE_URL is not set/);
    } finally {
      process.env.DATABASE_URL = saved;
    }
  });

  it('honours explicit pool options', () => {
    const pool = getPool({
      url: 'postgres://custom:custom@localhost:5555/customdb',
      max: 3,
      idleTimeoutMs: 1_234,
      connectionTimeoutMs: 555,
    });
    expect(pool.options.connectionString).toBe('postgres://custom:custom@localhost:5555/customdb');
    expect(pool.options.max).toBe(3);
    expect(pool.options.idleTimeoutMillis).toBe(1_234);
    expect(pool.options.connectionTimeoutMillis).toBe(555);
  });

  it('returns the same pool instance on repeated calls (singleton)', () => {
    const first = getPool();
    const second = getPool({ max: 999 }); // ignored — singleton already exists
    expect(second).toBe(first);
    expect(second.options.max).not.toBe(999);
  });

  it('throws when called while a close is in flight', async () => {
    getPool();
    const closing = closeDb();
    expect(() => getPool()).toThrow('Postgres pool is shutting down');
    await closing;
  });

  it('creates a fresh pool after a prior pool was closed', async () => {
    const first = getPool();
    await closeDb();
    const second = getPool();
    expect(second).not.toBe(first);
  });
});

describe('getDb', () => {
  it('returns a Drizzle client bound to the shared pool', () => {
    const db = getDb();
    expect(db).toBeDefined();
  });

  it('returns the same client instance on repeated calls (singleton)', () => {
    const first = getDb();
    const second = getDb();
    expect(second).toBe(first);
  });

  it('creates a fresh client after closeDb() resets the singleton', async () => {
    const first = getDb();
    await closeDb();
    const second = getDb();
    expect(second).not.toBe(first);
  });
});

describe('closeDb', () => {
  it('is a no-op when no pool has been created', async () => {
    await expect(closeDb()).resolves.toBeUndefined();
  });

  it('resets pool/db/closing even when pool.end() rejects', async () => {
    const pool = getPool();
    pool.end = () => Promise.reject(new Error('end failed'));

    await expect(closeDb()).rejects.toThrow('end failed');

    // State was still reset in the `finally` block — a subsequent getPool()
    // call succeeds rather than throwing "shutting down".
    expect(() => getPool()).not.toThrow();
  });
});

describe('_setDbClients', () => {
  it('overrides the singleton pool and db instances directly', () => {
    const fakePool = {} as ReturnType<typeof getPool>;
    const fakeDb = {} as ReturnType<typeof getDb>;
    _setDbClients(fakePool, fakeDb);
    expect(getPool()).toBe(fakePool);
    expect(getDb()).toBe(fakeDb);
  });
});
