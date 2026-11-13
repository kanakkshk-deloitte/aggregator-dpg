/**
 * Integration test for migration 0034 (`org_known_as`) against a live
 * Postgres: a database at 0033 holding a nested org tree with config-era
 * `known_as` keys is upgraded, and the result is checked: the `org_known_as`
 * table (one row per org) with its key and checks, the cascade from
 * `organisations`, the `known_as` reset, unchanged depth and `updated_at`, and
 * a re-run.
 *
 * Skipped unless `INTEGRATION_DATABASE_URL` is set; the URL is only used to
 * CREATE / DROP scratch databases (`orgcka_<random>`), so its role needs
 * CREATEDB.
 *
 * @module @aggregator-dpg/api
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

const adminUrl = process.env.INTEGRATION_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../drizzle/migrations',
);
/** 0033 `org_description_profile`: the state before this migration. */
const LAST_BEFORE_IDX = 33;
const TIMEOUT_MS = 120_000;

interface JournalEntry {
  idx: number;
  tag: string;
}

interface OrgRow {
  id: string;
  known_as: string;
  depth: number;
  updated_at: Date;
}

async function one<T extends Record<string, unknown>>(
  db: pg.Pool | pg.PoolClient,
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  const r = await db.query(sql, params);
  return r.rows[0] as T;
}

/** Inserts an active aggregator org under `parentId` with a `known_as` key. */
async function seedOrg(
  pool: pg.Pool,
  slug: string,
  parentId: string,
  knownAs: string,
): Promise<string> {
  const r = await one<{ id: string }>(
    pool,
    `INSERT INTO organisations (slug, name, org_type, parent_id, org_owner, status, known_as,
                                updated_at)
     VALUES ($1, $1, 'aggregator', $2,
             (SELECT org_owner FROM organisations WHERE org_type = 'network_facilitator'),
             'active', $3, '2026-01-01T00:00:00Z')
     RETURNING id`,
    [slug, parentId, knownAs],
  );
  return r.id;
}

suite('org_known_as (migration 0034) — integration', () => {
  let admin: pg.Client;
  let tmpDir: string;
  let pool: pg.Pool;
  let dbName: string;
  const ids = {} as Record<'root' | 'def' | 'a' | 'b' | 'c', string>;
  let before: Map<string, OrgRow>;

  async function rows(): Promise<Map<string, OrgRow>> {
    const r = await pool.query<OrgRow>('SELECT id, known_as, depth, updated_at FROM organisations');
    return new Map(r.rows.map((row) => [row.id, row]));
  }

  /** Inserts an org's list row; `values` is sent as JSON text. */
  const addList = (orgId: string, values: unknown) =>
    pool.query(
      `INSERT INTO org_known_as (org_id, known_as_values, updated_by) VALUES ($1, $2::jsonb, 'u1')`,
      [orgId, JSON.stringify(values)],
    );

  /** A list of `n` entries with distinct keys and names. */
  const listOf = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ key: `k${i}`, name: `N${i}` }));

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    const journal = JSON.parse(
      await readFile(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'),
    ) as { entries: JournalEntry[] } & Record<string, unknown>;
    const older = journal.entries.filter((e) => e.idx <= LAST_BEFORE_IDX);
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'org-known-as-'));
    const beforeFolder = path.join(tmpDir, 'migrations');
    await mkdir(path.join(beforeFolder, 'meta'), { recursive: true });
    for (const e of older) {
      await copyFile(
        path.join(MIGRATIONS_DIR, `${e.tag}.sql`),
        path.join(beforeFolder, `${e.tag}.sql`),
      );
    }
    await writeFile(
      path.join(beforeFolder, 'meta/_journal.json'),
      JSON.stringify({ ...journal, entries: older }, null, 2),
    );

    dbName = `orgcka_${randomBytes(4).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(adminUrl!);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({
      connectionString: url.toString(),
      max: 4,
      options: '-c aggregator_dpg.network=blue_dot',
    });
    // Teardown force-drops this scratch DB; swallow the 57P01 it sends an
    // attached backend so it isn't an unhandled error after tests pass.
    pool.on('error', () => undefined);
    await migrate(drizzle(pool), { migrationsFolder: beforeFolder });

    ids.root = (
      await one<{ id: string }>(
        pool,
        `SELECT id FROM organisations WHERE org_type = 'network_facilitator'`,
      )
    ).id;
    ids.def = (
      await one<{ id: string }>(pool, `SELECT id FROM organisations WHERE slug = 'default'`)
    ).id;
    ids.a = await seedOrg(pool, 'org-a', ids.root, 'state');
    ids.b = await seedOrg(pool, 'org-b', ids.a, 'district');
    ids.c = await seedOrg(pool, 'org-c', ids.root, 'aggregator');
    before = await rows();

    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_DIR });
  }, TIMEOUT_MS);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    if (dbName) {
      await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
    }
    await admin?.end().catch(() => undefined);
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it('creates org_known_as with its columns, empty', async () => {
    const cols = await pool.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'org_known_as'
        ORDER BY ordinal_position`,
    );
    const ts = {
      data_type: 'timestamp with time zone',
      is_nullable: 'NO',
      column_default: 'now()',
    };
    expect(cols.rows).toEqual([
      { column_name: 'org_id', data_type: 'uuid', is_nullable: 'NO', column_default: null },
      {
        column_name: 'known_as_values',
        data_type: 'jsonb',
        is_nullable: 'NO',
        column_default: null,
      },
      { column_name: 'created_at', ...ts },
      { column_name: 'updated_at', ...ts },
      { column_name: 'updated_by', data_type: 'text', is_nullable: 'NO', column_default: null },
    ]);
    expect((await one<{ n: number }>(pool, 'SELECT count(*)::int AS n FROM org_known_as')).n).toBe(
      0,
    );
    const col = await one<{ n: number }>(
      pool,
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'organisations' AND column_name = 'known_as_values'`,
    );
    expect(col.n).toBe(0);
  });

  it('keys the table by org: one row per org', async () => {
    const values = [
      { key: 'block', name: 'Block', default: true },
      { key: 'ward', name: 'Ward' },
    ];
    await addList(ids.a, values);
    await expect(addList(ids.a, [])).rejects.toThrow(/org_known_as_pkey/);
    await addList(ids.c, values);
    const stored = await one<{ known_as_values: unknown }>(
      pool,
      'SELECT known_as_values FROM org_known_as WHERE org_id = $1',
      [ids.a],
    );
    // The list comes back as stored, in order.
    expect(stored.known_as_values).toEqual(values);
    await pool.query('DELETE FROM org_known_as');
  });

  it.each([
    ['an object', { key: 'block', name: 'Block' }],
    ['a string', 'block'],
    ['null as JSON', null],
  ])('refuses %s instead of an array', async (_label, value) => {
    await expect(addList(ids.a, value)).rejects.toThrow(/org_known_as_values_array_chk/);
  });

  it('takes 20 entries and refuses 21', async () => {
    await addList(ids.a, listOf(20));
    await expect(addList(ids.c, listOf(21))).rejects.toThrow(/org_known_as_values_max_chk/);
    await pool.query('DELETE FROM org_known_as');
  });

  it('refuses a missing list, a missing writer and an unknown org', async () => {
    await expect(
      pool.query(`INSERT INTO org_known_as (org_id, updated_by) VALUES ($1, 'u1')`, [ids.a]),
    ).rejects.toThrow(/known_as_values/);
    await expect(
      pool.query(`INSERT INTO org_known_as (org_id, known_as_values) VALUES ($1, '[]')`, [ids.a]),
    ).rejects.toThrow(/updated_by/);
    await expect(addList('00000000-0000-4000-8000-0000000000ff', [])).rejects.toThrow(
      /org_known_as_org_id_fkey/,
    );
  });

  it('deletes the row with its org', async () => {
    const gone = await seedOrg(pool, 'org-gone', ids.root, 'aggregator');
    await addList(gone, [{ key: 'block', name: 'Block', default: true }]);
    await addList(ids.a, [{ key: 'block', name: 'Block', default: true }]);
    await pool.query('DELETE FROM organisations WHERE id = $1', [gone]);
    const left = await pool.query<{ org_id: string }>('SELECT org_id FROM org_known_as');
    expect(left.rows).toEqual([{ org_id: ids.a }]);
    await pool.query('DELETE FROM org_known_as');
  });

  it('resets every known_as to aggregator', async () => {
    const r = await pool.query<{ known_as: string }>('SELECT DISTINCT known_as FROM organisations');
    expect(r.rows).toEqual([{ known_as: 'aggregator' }]);
  });

  it('leaves depth and updated_at as they were', async () => {
    const after = await rows();
    for (const [id, row] of before) {
      expect(after.get(id)?.depth).toBe(row.depth);
      expect(after.get(id)?.updated_at).toEqual(row.updated_at);
    }
    expect(after.get(ids.b)?.depth).toBe(2);
  });

  it('is a no-op when re-applied', async () => {
    await addList(ids.a, [{ key: 'block', name: 'Block', default: true }]);
    const sql = await readFile(path.join(MIGRATIONS_DIR, '0034_org_known_as.sql'), 'utf8');
    const shape = `SELECT
      (SELECT md5(string_agg(id::text || ':' || depth || ':' || known_as || ':' ||
                             updated_at::text, ',' ORDER BY id))
         FROM organisations) AS rows,
      (SELECT md5(string_agg(org_id::text || ':' || known_as_values::text || ':' ||
                             updated_at::text, ',' ORDER BY org_id))
         FROM org_known_as) AS values,
      (SELECT count(*)::int FROM pg_indexes WHERE tablename = 'org_known_as') AS indexes,
      (SELECT count(*)::int FROM pg_constraint
        WHERE conrelid = 'public.org_known_as'::regclass) AS constraints`;
    const first = await one<{ rows: string; values: string; indexes: number; constraints: number }>(
      pool,
      shape,
    );
    // The primary key index; pkey, fkey and two checks.
    expect([first.indexes, first.constraints]).toEqual([1, 4]);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(sql);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    expect(await one(pool, shape)).toEqual(first);
  });
});
