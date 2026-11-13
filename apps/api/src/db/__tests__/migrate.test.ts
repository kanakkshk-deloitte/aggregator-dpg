/**
 * Unit tests for the migration runner (`runMigrations`).
 *
 * `drizzle-orm/node-postgres/migrator`'s `migrate()` is mocked and the shared
 * pool is replaced by a fake (per testing-requirements.md — no real DB/network
 * calls in unit tests) so these tests exercise the real folder-resolution,
 * advisory-lock ordering and error-propagation logic in `migrate.ts` without
 * touching a live database. The lock against a real Postgres is covered by
 * `contact-deploy.integration.test.ts`.
 *
 * The `isMain` CLI-entrypoint block (`if (isMain) { runMigrations()... }`) is
 * intentionally left uncovered: it only runs when this file is executed
 * directly as `node migrate.js` (`import.meta.url === file://${process.argv[1]}`),
 * which is never true under the Vitest runner (`process.argv[1]` is the
 * Vitest binary) — there is no way to exercise it as a unit test without
 * spawning a real child process, which would cross into integration-test
 * territory (real DB env vars) that this app deliberately keeps out of
 * `pnpm -w test`.
 *
 * @module @aggregator-dpg/api
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const migrateMock = vi.fn();

vi.mock('drizzle-orm/node-postgres/migrator', () => ({
  migrate: (...args: unknown[]) => migrateMock(...args),
}));

// The pre-migration guards have their own tests (migration-guards.test.ts);
// here they are recorded so the run order can be asserted.
const guardsMock = vi.fn(async (..._args: unknown[]): Promise<void> => undefined);
vi.mock('../migration-guards.js', () => ({
  runMigrationGuards: (...args: unknown[]) => guardsMock(...args),
}));

import { _setDbClients, closeDb } from '../client.js';
import { runMigrations } from '../migrate.js';

/** Records every call to the fake pool/client and to `migrate()` in order. */
let events: string[];
let released: unknown[];
let failUnlock = false;
let failLock = false;

function installFakePool(): void {
  events = [];
  released = [];
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('pg_advisory_unlock')) {
        events.push('unlock');
        if (failUnlock) throw new Error('connection terminated');
      } else if (sql.includes('pg_advisory_lock')) {
        events.push('lock');
        if (failLock) throw new Error('lock query failed');
      }
      return { rows: [] };
    }),
    release: vi.fn((err?: unknown) => {
      events.push('release');
      released.push(err);
    }),
  };
  const pool = { connect: vi.fn(async () => client), end: vi.fn(async () => undefined) };
  _setDbClients(pool as never, { fake: 'db' } as never);
  migrateMock.mockImplementation(async () => {
    events.push('migrate');
  });
}

beforeEach(() => {
  failUnlock = false;
  failLock = false;
  installFakePool();
});

afterEach(async () => {
  migrateMock.mockReset();
  await closeDb().catch(() => undefined);
  _setDbClients(null, null);
});

describe('runMigrations', () => {
  it('resolves the migrations folder relative to this module and calls migrate()', async () => {
    await runMigrations();

    expect(migrateMock).toHaveBeenCalledTimes(1);
    const [dbArg, options] = migrateMock.mock.calls[0] as [unknown, { migrationsFolder: string }];
    expect(dbArg).toEqual({ fake: 'db' });
    expect(options.migrationsFolder.replace(/\\/g, '/')).toMatch(
      /\/apps\/api\/drizzle\/migrations$/,
    );
  });

  it('holds the session advisory lock around migrate() and releases the connection', async () => {
    await runMigrations();

    expect(events).toEqual(['lock', 'migrate', 'unlock', 'release']);
    expect(released).toEqual([undefined]);
  });

  it('propagates a rejection from migrate() and still unlocks + releases', async () => {
    migrateMock.mockReset();
    migrateMock.mockImplementation(async () => {
      events.push('migrate');
      throw new Error('migration failed: relation already exists');
    });

    await expect(runMigrations()).rejects.toThrow('migration failed: relation already exists');
    expect(events).toEqual(['lock', 'migrate', 'unlock', 'release']);
  });

  it('discards the lock connection when the unlock fails', async () => {
    failUnlock = true;

    await runMigrations();

    expect(events).toEqual(['lock', 'migrate', 'unlock', 'release']);
    expect(released[0]).toBeInstanceOf(Error);
  });

  it('never migrates, and discards the connection, when taking the lock fails', async () => {
    failLock = true;

    await expect(runMigrations()).rejects.toThrow('lock query failed');

    expect(events).toEqual(['lock', 'release']);
    expect(migrateMock).not.toHaveBeenCalled();
    expect(released[0]).toBeInstanceOf(Error);
  });
});

describe('runMigrations — pre-migration guards', () => {
  beforeEach(() => {
    installFakePool();
    guardsMock.mockClear();
  });
  afterEach(async () => {
    delete process.env.ALLOW_TRAIN_ON_BOOT;
    await closeDb();
  });

  it('runs the guards before taking the lock, passing the override flag', async () => {
    guardsMock.mockImplementationOnce(async () => {
      events.push('guards');
    });
    process.env.ALLOW_TRAIN_ON_BOOT = 'true';
    await runMigrations();
    expect(events[0]).toBe('guards');
    expect(guardsMock.mock.calls[0]?.[2]).toBe(true);
  });

  it('never takes the lock or migrates when a guard refuses', async () => {
    guardsMock.mockImplementationOnce(async () => {
      throw new Error('refusing to apply the user & org instance upgrade');
    });
    await expect(runMigrations()).rejects.toThrow(/instance upgrade/);
    expect(events).toEqual([]);
    expect(migrateMock).not.toHaveBeenCalled();
  });
});
