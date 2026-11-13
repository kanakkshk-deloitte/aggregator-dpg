/**
 * Integration test for the Phase 1 `contact` deploy path, against a live
 * Postgres: an instance sitting at migration 0024 with legacy contact data
 * boots the new release, whose drizzle run applies 0025 (expand + backfill)
 * and 0026 (drop the legacy columns) in one transaction.
 *
 * Covers what `contact.integration.test.ts` does not: the full production
 * upgrade from real legacy rows, the 0025 pre-flight rejecting a cross-role
 * clash with the database left untouched at 0024, and concurrent migrators
 * (several API replicas booting at once) serialised by `migrateWithLock`.
 *
 * Skipped unless `INTEGRATION_DATABASE_URL` is set. The URL is only used to
 * CREATE / DROP scratch databases (`p1fix_<random>`) on the same server, so
 * its role needs CREATEDB; nothing is written to the database it names:
 *
 *   INTEGRATION_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
 *     pnpm --filter @aggregator-dpg/api exec vitest run src/db/__tests__/contact-deploy.integration.test.ts
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
import { migrateWithLock } from '../migrate.js';

const adminUrl = process.env.INTEGRATION_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../drizzle/migrations',
);
/** Last migration before the contact rollout. */
const LAST_LEGACY_IDX = 24;
const TIMEOUT_MS = 120_000;
const CONSENT = JSON.stringify({
  value: true,
  given_at: '2026-01-01T00:00:00.000Z',
  valid_till: '2027-01-01T00:00:00.000Z',
});

interface JournalEntry {
  idx: number;
  tag: string;
}

/** Fetches a single row from `sql`. */
async function one<T extends Record<string, unknown>>(
  pool: pg.Pool,
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  const r = await pool.query(sql, params);
  return r.rows[0] as T;
}

/** Counts the legacy contact columns still present on both tables. */
async function legacyColumnCount(pool: pg.Pool): Promise<number> {
  const r = await one<{ n: number }>(
    pool,
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema = 'public'
        AND ((table_name = 'aggregators' AND column_name IN ('contact', 'contact_phone', 'contact_email'))
          OR (table_name = 'aggregator_orgs' AND column_name IN ('owner_email', 'owner_phone')))`,
  );
  return r.n;
}

/** Number of migrations drizzle has recorded. */
async function appliedCount(pool: pg.Pool): Promise<number> {
  const r = await one<{ n: number }>(
    pool,
    'SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations',
  );
  return r.n;
}

/** Inserts a coordinator row in the pre-0025 (legacy jsonb) shape. */
async function seedCoordinator(
  pool: pg.Pool,
  slug: string,
  contact: Record<string, string>,
): Promise<string> {
  const r = await one<{ id: string }>(
    pool,
    `INSERT INTO aggregators (org_slug, actor_type, name, contact, consent, created_by, updated_by)
     VALUES ($1, 'aggregator', $1, $2::jsonb, $3::jsonb, 'it', 'it') RETURNING id`,
    [slug, JSON.stringify(contact), CONSENT],
  );
  return r.id;
}

/** Inserts an org row in the pre-0025 (owner_email / owner_phone) shape. */
async function seedOrg(pool: pg.Pool, slug: string, email: string, phone: string): Promise<string> {
  const r = await one<{ id: string }>(
    pool,
    `INSERT INTO aggregator_orgs (slug, display_name, owner_email, owner_phone)
     VALUES ($1, $1, $2, $3) RETURNING id`,
    [slug, email, phone],
  );
  return r.id;
}

/** Flattens an error and its `cause` chain into one string for matching. */
function errorText(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  while (cur instanceof Error) {
    parts.push(cur.message);
    cur = (cur as Error & { cause?: unknown }).cause;
  }
  return parts.join(' | ');
}

suite('contact deploy (0024 → 0025 + 0026) — integration', () => {
  let admin: pg.Client;
  let tmpDir: string;
  let legacyFolder: string;
  let fullJournalLength: number;
  const created: string[] = [];
  const pools: pg.Pool[] = [];
  const urlOf = new WeakMap<pg.Pool, string>();

  /** Creates an empty scratch database and returns a pool on it. */
  async function scratchDb(label: string): Promise<pg.Pool> {
    const name = `p1fix_${label}_${randomBytes(4).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${name}`);
    created.push(name);
    const url = new URL(adminUrl!);
    url.pathname = `/${name}`;
    // The network the 0029 consent backfill records when the ledger is empty
    // (the migration tool passes it the same way).
    const pool = new pg.Pool({
      connectionString: url.toString(),
      max: 4,
      options: '-c aggregator_dpg.network=blue_dot',
    });
    // Teardown force-drops this scratch DB; swallow the 57P01 it sends an
    // attached backend so it isn't an unhandled error after tests pass.
    pool.on('error', () => undefined);
    pools.push(pool);
    urlOf.set(pool, url.toString());
    return pool;
  }

  /** Migrates `pool`'s database with the migrations up to 0024 only. */
  async function migrateToLegacy(pool: pg.Pool): Promise<void> {
    await migrate(drizzle(pool), { migrationsFolder: legacyFolder });
    expect(await appliedCount(pool)).toBe(LAST_LEGACY_IDX + 1);
    expect(await legacyColumnCount(pool)).toBe(5);
  }

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();

    // A copy of the migrations folder holding only 0000–0024, so a database
    // can be put in the exact state an existing instance is in today.
    const journal = JSON.parse(
      await readFile(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'),
    ) as { entries: JournalEntry[] } & Record<string, unknown>;
    fullJournalLength = journal.entries.length;
    const legacy = journal.entries.filter((e) => e.idx <= LAST_LEGACY_IDX);
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'contact-deploy-'));
    legacyFolder = path.join(tmpDir, 'migrations');
    await mkdir(path.join(legacyFolder, 'meta'), { recursive: true });
    for (const e of legacy) {
      await copyFile(
        path.join(MIGRATIONS_DIR, `${e.tag}.sql`),
        path.join(legacyFolder, `${e.tag}.sql`),
      );
    }
    await writeFile(
      path.join(legacyFolder, 'meta/_journal.json'),
      JSON.stringify({ ...journal, entries: legacy }, null, 2),
    );
  });

  afterAll(async () => {
    await Promise.allSettled(pools.map((p) => p.end()));
    for (const name of created) {
      await admin?.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
    }
    await admin?.end();
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it(
    'upgrades legacy rows: every row linked, extras kept, legacy columns dropped',
    async () => {
      const pool = await scratchDb('upgrade');
      await migrateToLegacy(pool);

      const coordA = await seedCoordinator(pool, 'coord-a', {
        name: 'Coordinator A',
        email: 'Coord.A@Example.test',
        phone: '+919000000001',
        company: 'Acme Test Co',
      });
      const coordB = await seedCoordinator(pool, 'coord-b', {
        name: 'Coordinator B',
        email: 'coord.b@example.test',
        phone: '+919000000002',
      });
      const orgOwn = await seedOrg(pool, 'org-own', 'owner@example.test', '+919000000003');
      // Coordinator B also owns an org (same email AND phone): one contact.
      const orgShared = await seedOrg(pool, 'org-shared', 'coord.b@example.test', '+919000000002');

      await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_DIR });

      expect(await appliedCount(pool)).toBe(fullJournalLength);
      expect(await legacyColumnCount(pool)).toBe(0);
      const unlinked = await one<{ n: number }>(
        pool,
        `SELECT (SELECT count(*) FROM users WHERE contact_id IS NULL)
              + (SELECT count(*) FROM organisations WHERE org_owner IS NULL) AS n`,
      );
      expect(Number(unlinked.n)).toBe(0);
      // Three people, plus the network admin's placeholder contact (0028).
      expect((await one<{ n: number }>(pool, 'SELECT count(*)::int AS n FROM contact')).n).toBe(4);

      const coord = async (id: string) =>
        one<{
          name: string | null;
          email: string;
          phone: string;
          alternate_phone: string | null;
          legacy_org_details: unknown;
        }>(
          pool,
          `SELECT c.name, c.email, c.phone, a.alternate_phone, a.legacy_org_details
             FROM users a JOIN contact c ON c.id = a.contact_id WHERE a.id = $1`,
          [id],
        );
      expect(await coord(coordA)).toEqual({
        name: 'Coordinator A',
        email: 'coord.a@example.test',
        phone: '+919000000001',
        // Company belongs to the org since 0028; a flat coordinator lands in
        // the Default org, which never adopts, so it is kept on the row.
        alternate_phone: null,
        legacy_org_details: { company: 'Acme Test Co' },
      });
      expect(await coord(coordB)).toEqual({
        name: 'Coordinator B',
        email: 'coord.b@example.test',
        phone: '+919000000002',
        alternate_phone: null,
        legacy_org_details: null,
      });

      const org = async (id: string) =>
        one<{ name: string | null; email: string; phone: string }>(
          pool,
          `SELECT c.name, c.email, c.phone
             FROM organisations o
             JOIN users u ON u.id = o.org_owner
             JOIN contact c ON c.id = u.contact_id WHERE o.id = $1`,
          [id],
        );
      // Owner names were never stored locally; the backfill script fills them.
      expect(await org(orgOwn)).toEqual({
        name: null,
        email: 'owner@example.test',
        phone: '+919000000003',
      });
      expect(await org(orgShared)).toEqual({
        name: 'Coordinator B',
        email: 'coord.b@example.test',
        phone: '+919000000002',
      });
      const shared = await one<{ same: boolean }>(
        pool,
        `SELECT (SELECT contact_id FROM users WHERE id = $1)
              = (SELECT u.contact_id FROM organisations o JOIN users u ON u.id = o.org_owner
                  WHERE o.id = $2) AS same`,
        [coordB, orgShared],
      );
      expect(shared.same).toBe(true);
      // 0027: each org owner is an identity-only admin account; coordinator B
      // and the owner of org-shared are one person in two roles.
      const roles = await one<{ admins: number; coordinators: number; both: number }>(
        pool,
        `SELECT count(*) FILTER (WHERE user_type = 'admin')::int AS admins,
                count(*) FILTER (WHERE user_type = 'coordinator')::int AS coordinators,
                (SELECT count(*)::int FROM (SELECT contact_id FROM users GROUP BY contact_id
                   HAVING count(*) = 2) d) AS both
           FROM users`,
      );
      // Two owners plus the network admin (0028).
      expect(roles).toEqual({ admins: 3, coordinators: 2, both: 1 });
      // 0029: consent that lived only in the column is backfilled into the
      // ledger (network from the session GUC), linked to each coordinator.
      const ledger = await one<{ backfilled: number; linked: number; network: string }>(
        pool,
        `SELECT count(*)::int AS backfilled, count(user_id)::int AS linked, min(network) AS network
           FROM consent_record WHERE source = 'registration-backfill'`,
      );
      expect(ledger).toEqual({ backfilled: 2, linked: 2, network: 'blue_dot' });
    },
    TIMEOUT_MS,
  );

  it(
    'rejects a cross-role phone clash with the 0025 pre-flight and leaves the DB at 0024',
    async () => {
      const pool = await scratchDb('clash');
      await migrateToLegacy(pool);
      await seedCoordinator(pool, 'coord-clash', {
        name: 'Coordinator C',
        email: 'coord.c@example.test',
        phone: '+919000000011',
      });
      // An org owner using the coordinator's phone under a different email.
      await seedOrg(pool, 'org-clash', 'other.owner@example.test', '+919000000011');

      const failure = await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_DIR }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(failure).not.toBeNull();
      expect(errorText(failure)).toMatch(
        /0025_contact pre-flight failed: email_with_many_phones=0 phone_with_many_emails=1 bad_format=0/,
      );

      expect(await appliedCount(pool)).toBe(LAST_LEGACY_IDX + 1);
      expect(await legacyColumnCount(pool)).toBe(5);
      const t = await one<{ reg: string | null }>(
        pool,
        "SELECT to_regclass('public.contact') AS reg",
      );
      expect(t.reg).toBeNull();
    },
    TIMEOUT_MS,
  );

  it(
    'serialises concurrent migrators on a fresh database',
    async () => {
      const pool = await scratchDb('fresh');
      // Two "replicas": separate pools, as separate processes would have.
      const poolB = scratchDbPeer(pool);
      await Promise.all([
        migrateWithLock(drizzle(pool), pool, MIGRATIONS_DIR),
        migrateWithLock(drizzle(poolB), poolB, MIGRATIONS_DIR),
      ]);
      expect(await appliedCount(pool)).toBe(fullJournalLength);
      expect(await legacyColumnCount(pool)).toBe(0);
    },
    TIMEOUT_MS,
  );

  it(
    'serialises concurrent migrators upgrading a legacy database (0025 never re-runs after 0026)',
    async () => {
      const pool = await scratchDb('replicas');
      await migrateToLegacy(pool);
      await seedCoordinator(pool, 'coord-r', {
        name: 'Coordinator R',
        email: 'coord.r@example.test',
        phone: '+919000000021',
      });
      await seedOrg(pool, 'org-r', 'owner.r@example.test', '+919000000022');

      const peers = [pool, scratchDbPeer(pool), scratchDbPeer(pool)];
      await Promise.all(peers.map((p) => migrateWithLock(drizzle(p), p, MIGRATIONS_DIR)));

      expect(await appliedCount(pool)).toBe(fullJournalLength);
      expect(await legacyColumnCount(pool)).toBe(0);
      const n = await one<{ n: number }>(pool, 'SELECT count(*)::int AS n FROM contact');
      // Two people, plus the network admin's placeholder contact (0028).
      expect(n.n).toBe(3);
    },
    TIMEOUT_MS,
  );

  /** Opens a second, independent pool on the same database as `pool`. */
  function scratchDbPeer(pool: pg.Pool): pg.Pool {
    const peer = new pg.Pool({ connectionString: urlOf.get(pool), max: 4 });
    peer.on('error', () => undefined);
    pools.push(peer);
    return peer;
  }
});
