/**
 * Integration test for the instance-upgrade operator tool (`@aggregator-dpg/api`,
 * `tools/instance-upgrade.ts`) against a live Postgres: a database at 0022 holding an
 * org, coordinators with and without an org, consent in both homes and a
 * consumed invite is taken through the whole train by `run` — one transaction
 * that applies every migration and runs every verify gate. Covers `--dry-run`
 * (rolls back), the commit (journal rows identical to drizzle's, so a later
 * boot `migrate` is a no-op), the data kept, `check` before and after, the
 * fixes, every refusal (level, foreign row, drain and pre-flight blockers,
 * other sessions, no snapshot id) and both failure paths (a migration error
 * and a failing gate) leaving the database at 0022.
 *
 * Skipped unless `INTEGRATION_DATABASE_URL` is set; the URL is only used to
 * CREATE / DROP scratch databases (`trn_<random>`), so its role needs CREATEDB.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  appendFile,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { _main } from '../instance-upgrade.js';

const adminUrl = process.env.INTEGRATION_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '../../../drizzle/migrations');
const SQL_DIR = path.resolve(HERE, '../../../../../scripts/sql');
/** 0022 `campaign_pii_audit`: the level every deployed instance is at. */
const LAST_BEFORE_IDX = 22;
/** Journal rows at 0022 (0000 … 0022). */
const ROWS_AT_0022 = LAST_BEFORE_IDX + 1;
const TIMEOUT_MS = 180_000;
const STAMP = '2026-01-01T00:00:00.000Z';
const CONSENT = JSON.stringify({
  value: true,
  given_at: '2026-02-01T10:00:00.000Z',
  valid_till: '2027-02-01T10:00:00.000Z',
});

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}

async function one<T extends Record<string, unknown>>(
  pool: pg.Pool,
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  const r = await pool.query(sql, params);
  return r.rows[0] as T;
}

/** Runs the tool in-process; returns its exit code (a refusal → 1) and output. */
async function cli(
  url: string,
  argv: string[],
  env: Record<string, string | undefined> = {},
): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  const vars: Record<string, string | undefined> = {
    DATABASE_URL: url,
    AGGREGATOR_NETWORK: 'blue_dot',
    TRAIN_SQL_DIR: SQL_DIR,
    KEYCLOAK_URL: undefined,
    ...env,
  };
  for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v);
  try {
    const code = await _main(argv);
    return { code, out: lines.join('') };
  } catch (err) {
    return { code: 1, out: `${lines.join('')}REFUSED: ${(err as Error).message}\n` };
  } finally {
    spy.mockRestore();
    vi.unstubAllEnvs();
  }
}

/** Seeds an active org (its owner by email + phone) in the 0022 shape. */
async function seedOrg(pool: pg.Pool, slug: string, n: number): Promise<string> {
  const r = await one<{ id: string }>(
    pool,
    `INSERT INTO aggregator_orgs (slug, display_name, owner_email, owner_phone, status, created_at, updated_at)
     VALUES ($1, $1, $2, $3, 'active', $4, $4) RETURNING id`,
    [slug, `owner${n}@x.test`, `+91930000000${n}`, STAMP],
  );
  return r.id;
}

/** Seeds a coordinator in the 0022 shape, with its registration ledger row. */
async function seedCoordinator(
  pool: pg.Pool,
  p: {
    slug: string;
    n: number;
    orgId?: string;
    type?: string;
    inviteEmail?: string;
    status?: string;
  },
): Promise<string> {
  const contact = {
    name: `Coordinator ${p.n}`,
    email: `c${p.n}@x.test`,
    phone: `+91920000000${p.n}`,
    alternatePhone: `+91920000009${p.n}`,
  };
  const r = await one<{ id: string }>(
    pool,
    `INSERT INTO aggregators (org_slug, name, type, actor_type, contact, consent, status,
                              parent_org_id, invite_email, created_by, updated_by, created_at, updated_at)
     VALUES ($1, $1, $2, 'aggregator', $3::jsonb, $4::jsonb, $8, $5, $6, 'it', 'it', $7, $7)
     RETURNING id`,
    [
      p.slug,
      p.type ?? null,
      JSON.stringify(contact),
      CONSENT,
      p.orgId ?? null,
      p.inviteEmail ?? null,
      STAMP,
      p.status ?? 'active',
    ],
  );
  await pool.query(
    `INSERT INTO aggregator_consent_record
       (subject_type, subject_id, terms_version, privacy_version, network, brand, source, accepted_at)
     VALUES ('aggregator', $1, 1, 1, 'blue_dot', NULL, 'registration', $2)`,
    [r.id, STAMP],
  );
  return r.id;
}

suite('instance upgrade from 0022 (instance-upgrade run) — integration', () => {
  let admin: pg.Client;
  let tmpDir: string;
  const created: string[] = [];
  const pools: pg.Pool[] = [];
  const folders = new Map<number, string>();

  /** A migrations folder holding the shipped journal up to `lastIdx`. */
  async function folderAt(lastIdx: number): Promise<string> {
    const known = folders.get(lastIdx);
    if (known) return known;
    const journal = JSON.parse(
      await readFile(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'),
    ) as { entries: JournalEntry[] } & Record<string, unknown>;
    const before = journal.entries.filter((e) => e.idx <= lastIdx);
    const folder = path.join(tmpDir, `migrations-${lastIdx}`);
    await mkdir(path.join(folder, 'meta'), { recursive: true });
    for (const e of before) {
      await copyFile(path.join(MIGRATIONS_DIR, `${e.tag}.sql`), path.join(folder, `${e.tag}.sql`));
    }
    await writeFile(
      path.join(folder, 'meta/_journal.json'),
      JSON.stringify({ ...journal, entries: before }, null, 2),
    );
    folders.set(lastIdx, folder);
    return folder;
  }

  /**
   * A scratch database migrated up to `lastIdx` (`null`: nothing). Its pool
   * is named like the tool so the sessions guard ignores it; the sessions test
   * exercises the guard itself.
   */
  async function dbAt(
    lastIdx: number | null = LAST_BEFORE_IDX,
  ): Promise<{ pool: pg.Pool; url: string }> {
    const name = `trn_${randomBytes(5).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${name}`);
    created.push(name);
    const url = new URL(adminUrl!);
    url.pathname = `/${name}`;
    const pool = new pg.Pool({
      connectionString: url.toString(),
      max: 2,
      application_name: 'train-it',
    });
    // Teardown force-drops this scratch DB; swallow the 57P01 it sends an
    // attached backend so it isn't an unhandled error after tests pass.
    pool.on('error', () => undefined);
    pools.push(pool);
    if (lastIdx !== null) {
      await migrate(drizzle(pool), { migrationsFolder: await folderAt(lastIdx) });
    }
    return { pool, url: url.toString() };
  }

  async function rows(pool: pg.Pool): Promise<number> {
    const r = await one<{ n: number }>(
      pool,
      `SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`,
    );
    return r.n;
  }

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'train-'));
  }, TIMEOUT_MS);

  afterAll(async () => {
    await Promise.allSettled(pools.map((p) => p.end()));
    for (const name of created) {
      await admin?.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
    }
    await admin?.end().catch(() => undefined);
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  describe('a clean 0022 instance', () => {
    let pool: pg.Pool;
    let url: string;
    const ids = {} as Record<'org' | 'inOrg' | 'flat' | 'invited', string>;
    let checked: { code: number; out: string };
    let dry: { code: number; out: string };
    let committed: { code: number; out: string };
    let rowsAfterDry: number;

    beforeAll(async () => {
      ({ pool, url } = await dbAt());
      ids.org = await seedOrg(pool, 'org-train-1', 1);
      ids.inOrg = await seedCoordinator(pool, { slug: 'c1', n: 1, orgId: ids.org, type: 'seeker' });
      ids.flat = await seedCoordinator(pool, { slug: 'c2', n: 2 });
      await pool.query(
        `INSERT INTO registration_invites (parent_org_id, email, status, expires_at, created_by, consumed_at)
         VALUES ($1, 'invited@x.test', 'consumed', now() + interval '7 days', 'it', $2)`,
        [ids.org, '2026-01-01T00:05:00Z'],
      );
      ids.invited = await seedCoordinator(pool, {
        slug: 'c3',
        n: 3,
        orgId: ids.org,
        inviteEmail: 'invited@x.test',
      });
      checked = await cli(url, ['check']);
      dry = await cli(url, ['run', '--dry-run']);
      rowsAfterDry = await rows(pool);
      committed = await cli(url, ['run', '--snapshot-taken', 'snap-1']);
    }, TIMEOUT_MS);

    it('checks clean at 0022', () => {
      expect(checked.out).toContain('state=start');
      expect(checked.out).toContain('F19 keycloak: KEYCLOAK_* not set');
      expect(checked.out).toContain('CHECK PASSED');
      expect(checked.code).toBe(0);
    });

    it('rehearses with --dry-run and leaves 0022', () => {
      expect(dry.out, dry.out).toContain('every count equal');
      expect(dry.out).toContain('DRY RUN PASSED');
      expect(dry.code).toBe(0);
      expect(rowsAfterDry).toBe(ROWS_AT_0022);
    });

    it('commits the whole train with the rows drizzle would write', async () => {
      expect(committed.out).toContain('snapshot=snap-1');
      expect(committed.out).toContain('COMMITTED');
      expect(committed.code).toBe(0);
      const journal = JSON.parse(
        await readFile(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'),
      ) as { entries: JournalEntry[] };
      expect(await rows(pool)).toBe(journal.entries.length);
      // Boot's own migrator finds nothing to do.
      await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_DIR });
      expect(await rows(pool)).toBe(journal.entries.length);
    });

    it('keeps every coordinator, org, consent row and invite, under the same ids', async () => {
      const users = await pool.query<{ id: string; org: string; serves: string[] }>(
        `SELECT id, (SELECT slug FROM organisations o WHERE o.id = u.org_id) AS org, serves
           FROM users u WHERE user_type = 'coordinator' ORDER BY signalstack_org_slug`,
      );
      expect(users.rows.map((r) => [r.id, r.org])).toEqual([
        [ids.inOrg, 'org-train-1'],
        [ids.flat, 'default'],
        [ids.invited, 'org-train-1'],
      ]);
      expect(users.rows[0]?.serves).toEqual(['seeker']);
      const consent = await one<{ n: number }>(
        pool,
        `SELECT count(*)::int AS n FROM consent_record
          WHERE subject_type = 'user' AND user_id = ANY($1::uuid[])`,
        [[ids.inOrg, ids.flat, ids.invited]],
      );
      expect(consent.n).toBe(3);
      const invited = await one<{ invite_id: string | null }>(
        pool,
        `SELECT invite_id FROM users WHERE id = $1`,
        [ids.invited],
      );
      expect(invited.invite_id).not.toBeNull();
    });

    it('checks the applied train, and a second run is a no-op', async () => {
      const after = await cli(url, ['check']);
      expect(after.out).toContain('state=done');
      expect(after.out).toContain('I1 coordinators_without_identity info 3');
      expect(after.out).toContain('CHECK PASSED (train applied)');
      const again = await cli(url, ['run', '--snapshot-taken', 'snap-2']);
      expect(again.out).toContain('nothing pending');
      expect(again.code).toBe(0);
    });
  });

  it(
    'refuses a run without a snapshot id or the network',
    async () => {
      const { pool, url } = await dbAt();
      expect((await cli(url, ['run'])).out).toMatch(
        /REFUSED: --snapshot-taken <snapshot id> is required/,
      );
      expect((await cli(url, ['run', '--dry-run'], { AGGREGATOR_NETWORK: undefined })).out).toMatch(
        /REFUSED: AGGREGATOR_NETWORK must be set/,
      );
      expect(await rows(pool)).toBe(ROWS_AT_0022);
    },
    TIMEOUT_MS,
  );

  it(
    'refuses a fresh database and one below 0022',
    async () => {
      const fresh = await dbAt(null);
      expect((await cli(fresh.url, ['run', '--dry-run'])).out).toMatch(
        /REFUSED: the database is at nothing; the instance upgrade starts from 0022/,
      );
      const older = await dbAt(LAST_BEFORE_IDX - 1);
      expect((await cli(older.url, ['check'])).out).toMatch(
        /REFUSED: the database is at 0021_\w+: this tool takes/,
      );
    },
    TIMEOUT_MS,
  );

  it(
    'refuses a database with an applied migration that is not in this release',
    async () => {
      const { pool, url } = await dbAt();
      await pool.query(
        `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('x', 1790700000000)`,
      );
      expect((await cli(url, ['check'])).out).toMatch(
        /REFUSED: 1 applied migration\(s\) are not in this release/,
      );
    },
    TIMEOUT_MS,
  );

  it(
    'refuses while work is in flight or a pre-flight blocker remains, and the fixes clear them',
    async () => {
      const { pool, url } = await dbAt();
      const pending = await seedCoordinator(pool, { slug: 'p1', n: 1, status: 'pending' });
      await pool.query(
        `INSERT INTO bulk_uploads (aggregator_id, participant_type, s3_key, status, schema_id,
                                   schema_version, uploaded_by)
         VALUES ($1, 'seeker', 'k', 'pending', 's', '1', $1)`,
        [pending],
      );
      const blocked = await cli(url, ['run', '--snapshot-taken', 's']);
      expect(blocked.out).toMatch(/D1 coordinators_pending\s+blocker\s+1/);
      expect(blocked.out).toMatch(/REFUSED: 1 blocker\(s\)/);
      expect(await rows(pool)).toBe(ROWS_AT_0022);

      expect((await cli(url, ['check', '--fix', 'expire-stale-presigns'])).out).toContain(
        'updated 1 row(s)',
      );
      // The (now failed) upload is tenant data: retiring is refused until it is gone.
      const refused = await cli(url, ['check', '--fix', 'retire-registration', '--id', pending]);
      expect(refused.out).toMatch(/has 1 tenant row\(s\)/);
      expect(refused.code).toBe(1);
      await pool.query(`DELETE FROM bulk_uploads`);
      const dryFix = await cli(url, [
        'check',
        '--fix',
        'retire-registration',
        '--id',
        pending,
        '--dry-run',
      ]);
      expect(dryFix.out).toContain('rolled back (dry run)');
      const ok = await cli(url, ['check', '--fix', 'retire-registration', '--id', pending]);
      expect(ok.out).toContain('committed');
      expect((await cli(url, ['check'])).out).toContain('CHECK PASSED');

      const id = await seedCoordinator(pool, { slug: 'c9', n: 9 });
      await pool.query(
        `INSERT INTO aggregator_profile (aggregator_id, contact_name, created_by, updated_by)
         VALUES ($1, 'kept', 'it', 'it')`,
        [id],
      );
      const f22 = await cli(url, ['run', '--dry-run']);
      expect(f22.out).toMatch(/F22 aggregator_profile_with_data\s+blocker\s+1/);
      expect(f22.code).toBe(1);
    },
    TIMEOUT_MS,
  );

  it(
    'refuses while other sessions are connected',
    async () => {
      const { url } = await dbAt();
      const app = new pg.Pool({
        connectionString: url,
        max: 1,
        application_name: 'aggregator-api',
      });
      app.on('error', () => undefined);
      pools.push(app);
      await app.query('SELECT 1');
      expect((await cli(url, ['run', '--snapshot-taken', 's'])).out).toMatch(
        /REFUSED: other sessions are connected \(aggregator-api:1\)/,
      );
    },
    TIMEOUT_MS,
  );

  it(
    'rolls the whole train back when a migration fails',
    async () => {
      const { pool, url } = await dbAt();
      await seedCoordinator(pool, { slug: 'c8', n: 8 });
      // Outside `public`, so the pre-flight's object scan does not see it.
      await pool.query(`
        CREATE FUNCTION drizzle.refuse_last() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'injected'; END $$;
        CREATE TRIGGER refuse_last BEFORE INSERT ON drizzle.__drizzle_migrations
          FOR EACH ROW WHEN (NEW.created_at > 1791000000000) EXECUTE FUNCTION drizzle.refuse_last();`);
      const r = await cli(url, ['run', '--snapshot-taken', 's']);
      expect(r.out).toContain('RUN FAILED (P0001: injected) — rolled back: nothing was applied');
      expect(r.code).toBe(1);
      expect(await rows(pool)).toBe(ROWS_AT_0022);
      const t = await one<{ users: string | null }>(
        pool,
        `SELECT to_regclass('public.users')::text AS users`,
      );
      expect(t.users).toBeNull();
    },
    TIMEOUT_MS,
  );

  it(
    'rolls the whole train back when a verify gate is not 0',
    async () => {
      const { pool, url } = await dbAt();
      await seedCoordinator(pool, { slug: 'c7', n: 7 });
      const sql = path.join(tmpDir, `sql-${randomBytes(3).toString('hex')}`);
      await cp(SQL_DIR, sql, { recursive: true });
      await appendFile(
        path.join(sql, 'cleanup-verify.sql'),
        `\nSELECT 'V99 injected' AS check_id, 'gate' AS category, 1 AS n;\n`,
      );
      const r = await cli(url, ['run', '--snapshot-taken', 's'], { TRAIN_SQL_DIR: sql });
      expect(r.out).toContain('FAILING V99 injected = 1');
      expect(r.out).toContain('RUN FAILED — a gate is not 0; rolled back');
      expect(await rows(pool)).toBe(ROWS_AT_0022);
    },
    TIMEOUT_MS,
  );

  it(
    'takes a rehearsal database part-way through the instance upgrade to the end (gates only)',
    async () => {
      const { pool, url } = await dbAt(25);
      const checked = await cli(url, ['check']);
      expect(checked.out).toContain('state=partial');
      expect(checked.out).toContain('CHECK PASSED');
      const r = await cli(url, ['run', '--snapshot-taken', 's']);
      expect(r.out).toContain('verify gates only');
      expect(r.out).not.toContain('train-check (0022)');
      expect(r.out).toContain('applied 0026_');
      expect(r.out).toContain('COMMITTED');
      expect(await rows(pool)).toBeGreaterThan(26);
    },
    TIMEOUT_MS,
  );

  it(
    'rolls back when a migration touches a pre-existing row (updated_at fingerprint)',
    async () => {
      const { pool, url } = await dbAt();
      await seedCoordinator(pool, { slug: 'u1', n: 1 });
      // Fires at the last migration's bookkeeping row, after every migration ran.
      await pool.query(`
        CREATE FUNCTION drizzle.touch() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN UPDATE public.users SET updated_at = updated_at + interval '1 second'; RETURN NEW; END $$;
        CREATE TRIGGER touch AFTER INSERT ON drizzle.__drizzle_migrations
          FOR EACH ROW WHEN (NEW.created_at > 1791300000000) EXECUTE FUNCTION drizzle.touch();`);
      const r = await cli(url, ['run', '--snapshot-taken', 's']);
      expect(r.out).toContain('differ: coordinators_timestamps');
      expect(r.out).toContain('RUN FAILED — a gate is not 0; rolled back');
      expect(await rows(pool)).toBe(ROWS_AT_0022);
    },
    TIMEOUT_MS,
  );

  it(
    'rolls back when a completeness count differs',
    async () => {
      const { pool, url } = await dbAt();
      await seedCoordinator(pool, { slug: 'k1', n: 1 });
      const sql = path.join(tmpDir, `sql-${randomBytes(3).toString('hex')}`);
      await cp(SQL_DIR, sql, { recursive: true });
      await appendFile(
        path.join(sql, 'instance-upgrade-counts-after.sql'),
        `\nSELECT 'coordinators' AS key, 99 AS n;\n`,
      );
      const r = await cli(url, ['run', '--snapshot-taken', 's'], { TRAIN_SQL_DIR: sql });
      expect(r.out).toContain('differ: coordinators');
      expect(r.code).toBe(1);
      expect(await rows(pool)).toBe(ROWS_AT_0022);
    },
    TIMEOUT_MS,
  );

  it(
    'reads the real outcome when COMMIT itself fails',
    async () => {
      const { pool, url } = await dbAt();
      await seedCoordinator(pool, { slug: 'm1', n: 1 });
      // A deferred constraint trigger raises at COMMIT, after every gate passed.
      await pool.query(`
        CREATE FUNCTION drizzle.refuse_at_commit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'refused at commit'; END $$;
        CREATE CONSTRAINT TRIGGER refuse_at_commit AFTER INSERT ON drizzle.__drizzle_migrations
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
          WHEN (NEW.created_at > 1791300000000) EXECUTE FUNCTION drizzle.refuse_at_commit();`);
      const r = await cli(url, ['run', '--snapshot-taken', 's']);
      expect(r.out).toContain('COMMIT failed — nothing was applied, the database is unchanged');
      expect(r.code).toBe(1);
      expect(await rows(pool)).toBe(ROWS_AT_0022);
    },
    TIMEOUT_MS,
  );

  it(
    'reports a migration in progress and does not run alongside one',
    async () => {
      const { url } = await dbAt();
      const holder = new pg.Client({ connectionString: url, application_name: 'train-other' });
      await holder.connect();
      try {
        await holder.query(`SELECT pg_advisory_lock(hashtext('aggregator-dpg:migrations'))`);
        const checked = await cli(url, ['check']);
        expect(checked.out).toContain('MIGRATION IN PROGRESS');
        expect(checked.code).toBe(1);
        const r = await cli(url, ['run', '--snapshot-taken', 's']);
        expect(r.out).toContain('RUN FAILED (55P03)');
      } finally {
        await holder.end();
      }
    },
    TIMEOUT_MS,
  );

  it(
    'refuses enrich before the instance upgrade is applied',
    async () => {
      const { url } = await dbAt();
      expect((await cli(url, ['enrich', '--dry-run'])).out).toMatch(
        /REFUSED: enrich runs after the instance upgrade \(the database is at 0022_/,
      );
    },
    TIMEOUT_MS,
  );
});
