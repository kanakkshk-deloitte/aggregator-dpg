/**
 * Integration test for migration 0032 (`org_known_as`) against a live Postgres:
 * a database at 0031 holding a nested org tree is upgraded, and the result is
 * checked — `known_as` and the backfilled `depth`, NOT NULL, the root CHECK,
 * the insert trigger, the `organisation-verify.sql` depth gate, and a re-run.
 *
 * Skipped unless `INTEGRATION_DATABASE_URL` is set; the URL is only used to
 * CREATE / DROP scratch databases (`orgdepth_<random>`), so its role needs
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
import { runChecks } from '../../tools/instance-upgrade-db.js';

const adminUrl = process.env.INTEGRATION_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../drizzle/migrations',
);
const VERIFY_SQL = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../scripts/sql/organisation-verify.sql',
);
/** 0031 `rbac_seed`: the state before this migration. */
const LAST_BEFORE_IDX = 31;
const TIMEOUT_MS = 120_000;

interface JournalEntry {
  idx: number;
  tag: string;
}

async function one<T extends Record<string, unknown>>(
  db: pg.Pool | pg.PoolClient,
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  const r = await db.query(sql, params);
  return r.rows[0] as T;
}

/** Inserts an active aggregator org under `parentId`, owned by the root's owner. */
async function seedOrg(pool: pg.Pool, slug: string, parentId: string): Promise<string> {
  const r = await one<{ id: string }>(
    pool,
    `INSERT INTO organisations (slug, name, org_type, parent_id, org_owner, status)
     VALUES ($1, $1, 'aggregator', $2,
             (SELECT org_owner FROM organisations WHERE org_type = 'network_facilitator'), 'active')
     RETURNING id`,
    [slug, parentId],
  );
  return r.id;
}

suite('org depth (migration 0032) — integration', () => {
  let admin: pg.Client;
  let tmpDir: string;
  let pool: pg.Pool;
  let dbName: string;
  const ids = {} as Record<'root' | 'def' | 'a' | 'b' | 'top2', string>;

  async function depths(): Promise<Record<string, number>> {
    const r = await pool.query<{ id: string; depth: number }>(
      'SELECT id, depth FROM organisations',
    );
    return Object.fromEntries(r.rows.map((row) => [row.id, row.depth]));
  }

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    const journal = JSON.parse(
      await readFile(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'),
    ) as { entries: JournalEntry[] } & Record<string, unknown>;
    const before = journal.entries.filter((e) => e.idx <= LAST_BEFORE_IDX);
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'org-depth-'));
    const beforeFolder = path.join(tmpDir, 'migrations');
    await mkdir(path.join(beforeFolder, 'meta'), { recursive: true });
    for (const e of before) {
      await copyFile(
        path.join(MIGRATIONS_DIR, `${e.tag}.sql`),
        path.join(beforeFolder, `${e.tag}.sql`),
      );
    }
    await writeFile(
      path.join(beforeFolder, 'meta/_journal.json'),
      JSON.stringify({ ...journal, entries: before }, null, 2),
    );

    dbName = `orgdepth_${randomBytes(4).toString('hex')}`;
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
    ids.a = await seedOrg(pool, 'org-a', ids.root);
    ids.b = await seedOrg(pool, 'org-b', ids.a);
    ids.top2 = await seedOrg(pool, 'org-top2', ids.root);

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

  it('adds known_as with the aggregator default', async () => {
    const r = await pool.query<{ known_as: string }>('SELECT DISTINCT known_as FROM organisations');
    expect(r.rows).toEqual([{ known_as: 'aggregator' }]);
  });

  it('backfills depth from the parent chain', async () => {
    expect(await depths()).toEqual({
      [ids.root]: 0,
      [ids.def]: 1,
      [ids.a]: 1,
      [ids.b]: 2,
      [ids.top2]: 1,
    });
  });

  it('makes depth NOT NULL', async () => {
    const r = await one<{ is_nullable: string; data_type: string }>(
      pool,
      `SELECT is_nullable, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'organisations' AND column_name = 'depth'`,
    );
    expect(r).toEqual({ is_nullable: 'NO', data_type: 'smallint' });
    await expect(
      pool.query(`UPDATE organisations SET depth = NULL WHERE id = $1`, [ids.b]),
    ).rejects.toThrow(/null value in column "depth"/);
  });

  it('allows depth 0 for the network root only', async () => {
    await expect(
      pool.query(`UPDATE organisations SET depth = 0 WHERE id = $1`, [ids.a]),
    ).rejects.toThrow(/organisations_depth_root_chk/);
    await expect(
      pool.query(`UPDATE organisations SET depth = 1 WHERE id = $1`, [ids.root]),
    ).rejects.toThrow(/organisations_depth_root_chk/);
  });

  it('fills depth on an insert that does not send it', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const r = await one<{ depth: number }>(
        c,
        `INSERT INTO organisations (slug, name, org_type, parent_id, org_owner, status)
         VALUES ('org-c', 'org-c', 'aggregator', $1,
                 (SELECT org_owner FROM organisations WHERE org_type = 'network_facilitator'), 'active')
         RETURNING depth`,
        [ids.b],
      );
      expect(r.depth).toBe(3);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('keeps a depth the writer sends', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const r = await one<{ depth: number }>(
        c,
        `INSERT INTO organisations (slug, name, org_type, parent_id, org_owner, status, depth)
         VALUES ('org-d', 'org-d', 'aggregator', $1,
                 (SELECT org_owner FROM organisations WHERE org_type = 'network_facilitator'), 'active', 2)
         RETURNING depth`,
        [ids.a],
      );
      expect(r.depth).toBe(2);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('passes the depth gate of organisation-verify.sql, and fails it on a broken chain', async () => {
    const c = await pool.connect();
    try {
      const ok = await runChecks(c, VERIFY_SQL);
      expect(ok.find((r) => r.checkId === 'V9 depth_chain')).toEqual({
        checkId: 'V9 depth_chain',
        category: 'gate',
        n: 0,
      });
      await c.query('BEGIN');
      await c.query(`UPDATE organisations SET depth = 5 WHERE id = $1`, [ids.b]);
      const broken = await runChecks(c, VERIFY_SQL);
      expect(broken.find((r) => r.checkId === 'V9 depth_chain')?.n).toBe(1);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('is a no-op when re-applied', async () => {
    const sql = await readFile(path.join(MIGRATIONS_DIR, '0032_org_known_as.sql'), 'utf8');
    const shape = `SELECT
      (SELECT md5(string_agg(id::text || ':' || depth || ':' || known_as, ',' ORDER BY id))
         FROM organisations) AS rows,
      (SELECT count(*)::int FROM pg_constraint
        WHERE conrelid = 'public.organisations'::regclass
          AND conname = 'organisations_depth_root_chk') AS checks,
      (SELECT count(*)::int FROM pg_trigger
        WHERE tgrelid = 'public.organisations'::regclass
          AND tgname = 'organisations_fill_depth') AS triggers`;
    const before = await one<{ rows: string; checks: number; triggers: number }>(pool, shape);
    expect(before.checks).toBe(1);
    expect(before.triggers).toBe(1);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(sql);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    expect(await one(pool, shape)).toEqual(before);
  });
});
