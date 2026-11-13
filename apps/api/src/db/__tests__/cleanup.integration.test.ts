/**
 * Integration test for migration 0029 (`cleanup`, user & org refactor Phase 4)
 * against a live Postgres: a database at 0028 holding consent in both homes,
 * domain types, alternate phones and invited coordinators is upgraded, and
 * every step's result is checked — the consent ledger (rename, typed links,
 * `valid_till`, the backfill, the append-only trigger), `serves`,
 * `alternate_phone`, the invite link, the renames, the re-created role CHECK,
 * `updated_at` untouched, the verify gates, a re-run, and the first-run
 * blockers.
 *
 * Skipped unless `INTEGRATION_DATABASE_URL` is set; the URL is only used to
 * CREATE / DROP scratch databases (`p4cln_<random>`), so its role needs
 * CREATEDB.
 *
 * @module @aggregator-dpg/api
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
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
const VERIFY_SQL = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../scripts/sql/cleanup-verify.sql',
);
/** 0028 `organisations`: the state before this phase. */
const LAST_BEFORE_IDX = 28;
const TIMEOUT_MS = 120_000;
const STAMP = '2026-01-01T00:00:00.000Z';
const GIVEN_AT = '2026-02-01T10:00:00.000Z';
const VALID_TILL = '2027-02-01T10:00:00.000Z';
/** The session GUC the migration tool passes when the ledger is empty. */
const NETWORK_OPTION = '-c aggregator_dpg.network=blue_dot -c aggregator_dpg.brand=up-gzb';

interface JournalEntry {
  idx: number;
  tag: string;
}

async function one<T extends Record<string, unknown>>(
  pool: pg.Pool,
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  const r = await pool.query(sql, params);
  return r.rows[0] as T;
}

/** The consent jsonb a coordinator carries at 0028. */
function consentOf(value: unknown = true): string {
  return JSON.stringify({ value, given_at: GIVEN_AT, valid_till: VALID_TILL });
}

/** Inserts a coordinator in the 0028 shape (in the Default org unless given) and returns its id. */
async function seedCoordinator(
  pool: pg.Pool,
  slug: string,
  p: {
    email: string;
    phone: string;
    type?: string | null;
    alternatePhone?: string;
    inviteEmail?: string | null;
    orgId?: string;
    consentValue?: unknown;
    /** Raw `contact_extra` (overrides `alternatePhone`). */
    contactExtra?: unknown;
    createdAt?: string;
  },
): Promise<string> {
  await pool.query(
    `INSERT INTO contact (id, email, phone, name) VALUES (contact_id_of($1, $2), $1, $2, 'P')`,
    [p.email, p.phone],
  );
  const r = await one<{ id: string }>(
    pool,
    `INSERT INTO users (user_type, contact_id, signalstack_org_slug, signalstack_org_name, actor_type,
                        type, consent, contact_extra, org_id, invite_email, status,
                        created_by, updated_by, created_at, updated_at)
     VALUES ('coordinator', contact_id_of($2, $3), $1, $1, 'aggregator', $4, $5::jsonb, $6::jsonb,
             coalesce($7, (SELECT id FROM organisations WHERE slug = 'default')), $8, 'active',
             'it', 'it', $9, $9)
     RETURNING id`,
    [
      slug,
      p.email,
      p.phone,
      p.type ?? null,
      consentOf(p.consentValue ?? true),
      JSON.stringify(
        p.contactExtra ??
          (p.alternatePhone !== undefined ? { alternatePhone: p.alternatePhone } : {}),
      ),
      p.orgId ?? null,
      p.inviteEmail ?? null,
      p.createdAt ?? STAMP,
    ],
  );
  return r.id;
}

/** Inserts an active aggregator org (and its owner's admin account) in the 0028 shape. */
async function seedOrg(pool: pg.Pool, slug: string, email: string): Promise<string> {
  await pool.query(
    `INSERT INTO contact (id, email) VALUES (contact_id_of($1, NULL), $1) ON CONFLICT DO NOTHING`,
    [email],
  );
  const admin = await one<{ id: string }>(
    pool,
    `INSERT INTO users (user_type, contact_id, status, profile, contact_extra, created_by, updated_by)
     VALUES ('admin', contact_id_of($1, NULL), NULL, NULL, NULL, 'it', 'it')
     ON CONFLICT (contact_id, user_type) DO UPDATE SET updated_by = 'it'
     RETURNING id`,
    [email],
  );
  const r = await one<{ id: string }>(
    pool,
    `INSERT INTO organisations (slug, name, org_type, parent_id, org_owner, status)
     VALUES ($1, $1, 'aggregator', (SELECT id FROM organisations WHERE org_type = 'network_facilitator'),
             $2, 'active')
     RETURNING id`,
    [slug, admin.id],
  );
  return r.id;
}

/** Inserts a consumed invite for `email` in `orgId`, consumed at `consumedAt`. */
async function seedInvite(
  pool: pg.Pool,
  orgId: string,
  email: string,
  consumedAt: string,
): Promise<string> {
  const jti = randomUUID();
  await pool.query(
    `INSERT INTO registration_invites (jti, org_id, email, status, expires_at, created_by, consumed_at)
     VALUES ($1, $2, $3, 'consumed', now() + interval '7 days', 'it', $4)`,
    [jti, orgId, email, consumedAt],
  );
  return jti;
}

/** Appends a ledger row in the 0028 shape. */
async function seedLedger(
  pool: pg.Pool,
  p: {
    subjectType: 'aggregator' | 'org';
    subjectId: string;
    source?: string;
    acceptedAt: string;
    brand?: string | null;
    versions?: [number, number];
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO aggregator_consent_record
       (subject_type, subject_id, terms_version, privacy_version, network, brand, source, accepted_at)
     VALUES ($1, $2, $3, $4, 'blue_dot', $5, $6, $7)`,
    [
      p.subjectType,
      p.subjectId,
      p.versions?.[0] ?? 1,
      p.versions?.[1] ?? 1,
      p.brand ?? null,
      p.source ?? 'registration',
      p.acceptedAt,
    ],
  );
}

suite('cleanup (migration 0029) — integration', () => {
  let admin: pg.Client;
  let tmpDir: string;
  let beforeFolder: string;
  const created: string[] = [];
  const pools: pg.Pool[] = [];
  let pool: pg.Pool;
  const ids = {} as Record<'c1' | 'c2' | 'c3' | 'org' | 'invNear' | 'invFar' | 'orphan', string>;

  async function scratchDb(label: string, options?: string): Promise<pg.Pool> {
    const name = `p4cln_${label}_${randomBytes(4).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${name}`);
    created.push(name);
    const url = new URL(adminUrl!);
    url.pathname = `/${name}`;
    const p = new pg.Pool({
      connectionString: url.toString(),
      max: 4,
      ...(options ? { options } : {}),
    });
    // Teardown force-drops this scratch DB; swallow the 57P01 it sends an
    // attached backend so it isn't an unhandled error after tests pass.
    p.on('error', () => undefined);
    pools.push(p);
    return p;
  }

  /** A scratch database at 0028. */
  async function dbAtBefore(label: string, options?: string): Promise<pg.Pool> {
    const p = await scratchDb(label, options);
    await migrate(drizzle(p), { migrationsFolder: beforeFolder });
    return p;
  }

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    const journal = JSON.parse(
      await readFile(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'),
    ) as { entries: JournalEntry[] } & Record<string, unknown>;
    const before = journal.entries.filter((e) => e.idx <= LAST_BEFORE_IDX);
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'cleanup-'));
    beforeFolder = path.join(tmpDir, 'migrations');
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

    pool = await dbAtBefore('upgrade');
    ids.org = await seedOrg(pool, 'org-p4-1111', 'owner@x.test');
    // c1: consent in both homes, a domain, a padded alternate phone, and two
    // consumed invites for its invited address (the nearest one wins).
    ids.c1 = await seedCoordinator(pool, 'c1', {
      email: 'c1@x.test',
      phone: '+919200000001',
      type: 'seeker',
      alternatePhone: ' +919200000099 ',
      inviteEmail: 'invited@x.test',
      orgId: ids.org,
    });
    ids.invNear = await seedInvite(pool, ids.org, 'Invited@X.test', '2026-01-01T00:05:00Z');
    ids.invFar = await seedInvite(pool, ids.org, 'invited@x.test', '2026-03-01T00:00:00Z');
    await seedLedger(pool, {
      subjectType: 'aggregator',
      subjectId: ids.c1,
      acceptedAt: '2026-01-01T00:00:00Z',
      versions: [2, 3],
      brand: 'up-gzb',
    });
    // c2: consent only in the column (backfilled), legacy 'both', an invited
    // address with no invite left, and a bulk attestation (not a registration).
    ids.c2 = await seedCoordinator(pool, 'c2', {
      email: 'c2@x.test',
      phone: '+919200000002',
      type: 'both',
      inviteEmail: 'gone@x.test',
    });
    await seedLedger(pool, {
      subjectType: 'aggregator',
      subjectId: ids.c2,
      source: 'bulk_upload:u1:v1',
      acceptedAt: '2026-01-15T00:00:00Z',
    });
    // The org's own consent, and a row whose subject is long gone.
    await seedLedger(pool, {
      subjectType: 'org',
      subjectId: ids.org,
      acceptedAt: '2026-01-02T00:00:00Z',
    });
    ids.orphan = randomUUID();
    await seedLedger(pool, {
      subjectType: 'aggregator',
      subjectId: ids.orphan,
      acceptedAt: '2026-01-03T00:00:00Z',
    });
    // c3: no domain; its registration row is the NEWEST ledger row, so the
    // backfill takes its network and brand.
    ids.c3 = await seedCoordinator(pool, 'c3', { email: 'c3@x.test', phone: '+919200000003' });
    await seedLedger(pool, {
      subjectType: 'aggregator',
      subjectId: ids.c3,
      acceptedAt: '2026-03-01T00:00:00Z',
      versions: [4, 4],
    });

    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_DIR });
  }, TIMEOUT_MS);

  afterAll(async () => {
    await Promise.allSettled(pools.map((p) => p.end()));
    for (const name of created) {
      await admin?.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
    }
    await admin?.end().catch(() => undefined);
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it('renames the ledger and maps the subject types', async () => {
    const t = await one<{ old: string | null; neu: string | null }>(
      pool,
      `SELECT to_regclass('public.aggregator_consent_record')::text AS old,
              to_regclass('public.consent_record')::text AS neu`,
    );
    expect(t).toEqual({ old: null, neu: 'consent_record' });
    const types = await pool.query(`SELECT DISTINCT subject_type FROM consent_record ORDER BY 1`);
    expect(types.rows.map((r: { subject_type: string }) => r.subject_type)).toEqual([
      'organisation',
      'user',
    ]);
  });

  it('links each row to its subject, with valid_till on the registration row', async () => {
    const c1 = await one<{ user_id: string; valid_till: Date }>(
      pool,
      `SELECT user_id, valid_till FROM consent_record WHERE subject_id = $1 AND source = 'registration'`,
      [ids.c1],
    );
    expect(c1.user_id).toBe(ids.c1);
    expect(c1.valid_till.toISOString()).toBe(VALID_TILL);
    const org = await one<{ org_id: string; user_id: string | null }>(
      pool,
      `SELECT org_id, user_id FROM consent_record WHERE subject_id = $1`,
      [ids.org],
    );
    expect(org).toEqual({ org_id: ids.org, user_id: null });
    const orphan = await one<{ user_id: string | null; org_id: string | null }>(
      pool,
      `SELECT user_id, org_id FROM consent_record WHERE subject_id = $1`,
      [ids.orphan],
    );
    expect(orphan).toEqual({ user_id: null, org_id: null });
  });

  it('backfills consent that lived only in the column, from the newest row and the earliest terms', async () => {
    const rows = await pool.query(
      `SELECT source, accepted_at, valid_till, network, brand, terms_version, privacy_version, user_id
         FROM consent_record WHERE subject_id = $1 ORDER BY accepted_at`,
      [ids.c2],
    );
    expect(rows.rows).toHaveLength(2);
    const [attestation, backfill] = rows.rows as Array<Record<string, unknown>>;
    expect(attestation).toMatchObject({
      source: 'bulk_upload:u1:v1',
      valid_till: null,
      user_id: ids.c2,
    });
    expect(backfill).toMatchObject({
      source: 'registration-backfill',
      network: 'blue_dot',
      brand: null,
      terms_version: 2,
      privacy_version: 3,
      user_id: ids.c2,
    });
    expect((backfill!['accepted_at'] as Date).toISOString()).toBe(GIVEN_AT);
    expect((backfill!['valid_till'] as Date).toISOString()).toBe(VALID_TILL);
  });

  it("moves type to serves ('both' and NULL mean every domain) and keeps admins empty", async () => {
    const r = await pool.query(
      `SELECT id, serves FROM users WHERE id = ANY($1) ORDER BY signalstack_org_slug`,
      [[ids.c1, ids.c2, ids.c3]],
    );
    expect(r.rows.map((x: { serves: string[] }) => x.serves)).toEqual([['seeker'], [], []]);
    const admins = await one<{ n: number }>(
      pool,
      `SELECT count(*)::int AS n FROM users WHERE user_type = 'admin' AND serves <> '{}'`,
    );
    expect(admins.n).toBe(0);
  });

  it('moves the alternate phone verbatim', async () => {
    const r = await one<{ alternate_phone: string | null }>(
      pool,
      `SELECT alternate_phone FROM users WHERE id = $1`,
      [ids.c1],
    );
    expect(r.alternate_phone).toBe(' +919200000099 ');
  });

  it('links the nearest consumed invite and keeps an unmatched address on the row', async () => {
    const c1 = await one<{ invite_id: string | null }>(
      pool,
      `SELECT invite_id FROM users WHERE id = $1`,
      [ids.c1],
    );
    expect(c1.invite_id).toBe(ids.invNear);
    const c2 = await one<{ invite_id: string | null; legacy: string | null }>(
      pool,
      `SELECT invite_id, profile->>'legacy_invite_email' AS legacy FROM users WHERE id = $1`,
      [ids.c2],
    );
    expect(c2).toEqual({ invite_id: null, legacy: 'gone@x.test' });
  });

  it('drops the old columns and types, and renames the rest', async () => {
    const cols = await pool.query(
      `SELECT table_name || '.' || column_name AS c FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (table_name, column_name) IN (('users','consent'), ('users','type'), ('users','actor_type'),
                                            ('users','contact_extra'), ('users','invite_email'),
                                            ('onboarding','org_slug'), ('onboarding','signalstack_org_slug'),
                                            ('campaign_pii_audit','actor_org_id'),
                                            ('campaign_pii_audit','actor_signalstack_org_id'))
        ORDER BY 1`,
    );
    expect(cols.rows.map((r: { c: string }) => r.c)).toEqual([
      'campaign_pii_audit.actor_signalstack_org_id',
      'onboarding.signalstack_org_slug',
    ]);
    const types = await one<{ old: string | null; actor: string | null; neu: string | null }>(
      pool,
      `SELECT to_regtype('public.aggregator_status')::text AS old,
              to_regtype('public.aggregator_actor_type')::text AS actor,
              to_regtype('public.registration_status')::text AS neu`,
    );
    expect(types).toEqual({ old: null, actor: null, neu: 'registration_status' });
  });

  it('never bumps updated_at on coordinators', async () => {
    const r = await one<{ n: number }>(
      pool,
      `SELECT count(*)::int AS n FROM users
        WHERE user_type = 'coordinator' AND updated_at <> $1::timestamptz`,
      [STAMP],
    );
    expect(r.n).toBe(0);
  });

  it('passes every gate of scripts/sql/cleanup-verify.sql', async () => {
    const script = (await readFile(VERIFY_SQL, 'utf8'))
      .split('\n')
      .filter((l) => !l.startsWith('\\'))
      .join('\n');
    const results: Record<string, number> = {};
    for (const stmt of script.split(/;\s*\n/).map((s) => s.trim())) {
      if (!/\bSELECT\b/i.test(stmt)) continue;
      const r = await one<{ check_id: string; n: number }>(pool, stmt);
      results[r.check_id] = Number(r.n);
    }
    expect(Object.keys(results)).toHaveLength(7);
    for (const [check, n] of Object.entries(results)) {
      // V4 is informational (the orphan row here).
      expect({ check, n }).toEqual({ check, n: check.startsWith('V4') ? 1 : 0 });
    }
  });

  it('refuses any change to the ledger except a link dropping to NULL', async () => {
    await expect(
      pool.query(`UPDATE consent_record SET network = 'x' WHERE subject_id = $1`, [ids.c1]),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query(`DELETE FROM consent_record WHERE subject_id = $1`, [ids.c1]),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query(`UPDATE consent_record SET user_id = $2 WHERE subject_id = $1`, [ids.c1, ids.c3]),
    ).rejects.toThrow(/append-only|consent_record_subject_chk/);
    // Deleting the subject keeps its consent, unlinked (P4-3).
    await pool.query(`DELETE FROM users WHERE id = $1`, [ids.c3]);
    const r = await one<{ n: number; linked: number }>(
      pool,
      `SELECT count(*)::int AS n, count(user_id)::int AS linked FROM consent_record WHERE subject_id = $1`,
      [ids.c3],
    );
    expect(r).toEqual({ n: 1, linked: 0 });
  });

  it('enforces the re-created row-shape rules', async () => {
    const adminRow = await one<{ id: string }>(
      pool,
      `SELECT org_owner AS id FROM organisations WHERE id = $1`,
      [ids.org],
    );
    await expect(
      pool.query(`UPDATE users SET serves = '{seeker}' WHERE id = $1`, [adminRow.id]),
    ).rejects.toThrow(/users_role_shape_chk/);
    await expect(
      pool.query(`UPDATE users SET serves = ARRAY[NULL]::text[] WHERE id = $1`, [ids.c1]),
    ).rejects.toThrow(/users_serves_no_null_chk/);
    // A coordinator still needs its profile (0028's rule, kept).
    await expect(
      pool.query(`UPDATE users SET profile = NULL WHERE id = $1`, [ids.c1]),
    ).rejects.toThrow(/users_role_shape_chk/);
  });

  it('is a no-op when re-applied', async () => {
    const sql = await readFile(path.join(MIGRATIONS_DIR, '0029_cleanup.sql'), 'utf8');
    const snapshot = async () =>
      one<{ s: string }>(
        pool,
        `SELECT md5((SELECT string_agg(id::text || coalesce(user_id::text, '-') || coalesce(valid_till::text, '-'), ',' ORDER BY id) FROM consent_record)
                 || (SELECT string_agg(id::text || serves::text || coalesce(invite_id::text, '-') || updated_at::text, ',' ORDER BY id) FROM users)) AS s`,
      );
    const before = await snapshot();
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(sql);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    expect((await snapshot()).s).toBe(before.s);
  });

  it('refuses the first run when a stored consent is not true (nothing applied)', async () => {
    const p = await dbAtBefore('blocker');
    await seedCoordinator(p, 'nope', {
      email: 'nope@x.test',
      phone: '+919200000010',
      consentValue: false,
    });
    await expect(migrate(drizzle(p), { migrationsFolder: MIGRATIONS_DIR })).rejects.toThrow();
    const t = await one<{ t: string | null }>(
      p,
      `SELECT to_regclass('public.consent_record')::text AS t`,
    );
    expect(t.t).toBeNull();
  });

  it('refuses a backfill whose network is unknown, and uses the session GUC when given', async () => {
    const bare = await dbAtBefore('nonet');
    await seedCoordinator(bare, 'bare', { email: 'bare@x.test', phone: '+919200000011' });
    await expect(migrate(drizzle(bare), { migrationsFolder: MIGRATIONS_DIR })).rejects.toThrow();

    const withGuc = await dbAtBefore('guc', NETWORK_OPTION);
    const id = await seedCoordinator(withGuc, 'guc', {
      email: 'guc@x.test',
      phone: '+919200000012',
    });
    await migrate(drizzle(withGuc), { migrationsFolder: MIGRATIONS_DIR });
    const r = await one<{ network: string; brand: string; source: string }>(
      withGuc,
      `SELECT network, brand, source FROM consent_record WHERE user_id = $1`,
      [id],
    );
    expect(r).toEqual({ network: 'blue_dot', brand: 'up-gzb', source: 'registration-backfill' });
  });

  it('refuses TRUNCATE on the ledger', async () => {
    await expect(pool.query('TRUNCATE consent_record')).rejects.toThrow(/append-only/);
  });

  it("keeps an org's consent, unlinked, through the org delete and owner-release chain", async () => {
    const orgId = await one<{ id: string }>(
      pool,
      `INSERT INTO organisations (slug, name, org_type, parent_id, org_owner, status)
       SELECT 'p4-del-org', 'P4 Del Org', 'aggregator', parent_id, org_owner, 'active'
         FROM organisations WHERE id = $1 RETURNING id`,
      [ids.org],
    );
    await pool.query(
      `INSERT INTO consent_record (subject_type, subject_id, org_id, terms_version, privacy_version,
                                   network, source, accepted_at)
       VALUES ('organisation', $1, $1, 1, 1, 'blue_dot', 'registration', now())`,
      [orgId.id],
    );
    await pool.query(`DELETE FROM organisations WHERE id = $1`, [orgId.id]);
    const r = await one<{ org_id: string | null }>(
      pool,
      `SELECT org_id FROM consent_record WHERE subject_id = $1`,
      [orgId.id],
    );
    expect(r.org_id).toBeNull();
  });

  it('hands shared invites out in registration order and keeps a left-over address on the row', async () => {
    const p = await dbAtBefore('invites');
    const org = await seedOrg(p, 'org-inv-1111', 'owner.inv@x.test');
    const first = await seedCoordinator(p, 'inv-first', {
      email: 'f@x.test',
      phone: '+919200000020',
      inviteEmail: 'shared@x.test',
      orgId: org,
      createdAt: '2026-01-01T00:00:00Z',
    });
    const second = await seedCoordinator(p, 'inv-second', {
      email: 's@x.test',
      phone: '+919200000021',
      inviteEmail: 'shared@x.test',
      orgId: org,
      createdAt: '2026-01-01T00:03:00Z',
    });
    const third = await seedCoordinator(p, 'inv-third', {
      email: 't@x.test',
      phone: '+919200000022',
      inviteEmail: 'shared@x.test',
      orgId: org,
      createdAt: '2026-01-01T00:04:00Z',
    });
    const near = await seedInvite(p, org, 'shared@x.test', '2026-01-01T00:01:00Z');
    const far = await seedInvite(p, org, 'shared@x.test', '2026-01-01T02:00:00Z');
    for (const id of [first, second, third]) {
      await seedLedger(p, {
        subjectType: 'aggregator',
        subjectId: id,
        acceptedAt: '2026-01-01T00:00:00Z',
      });
    }
    await migrate(drizzle(p), { migrationsFolder: MIGRATIONS_DIR });
    const rows = await p.query(
      `SELECT id, invite_id, profile->>'legacy_invite_email' AS legacy FROM users WHERE id = ANY($1)`,
      [[first, second, third]],
    );
    const by = Object.fromEntries(
      rows.rows.map((r: { id: string; invite_id: string | null; legacy: string | null }) => [
        r.id,
        r,
      ]),
    );
    // The earliest takes the nearest; the next one still gets the free invite.
    expect(by[first]).toMatchObject({ invite_id: near, legacy: null });
    expect(by[second]).toMatchObject({ invite_id: far, legacy: null });
    expect(by[third]).toMatchObject({ invite_id: null, legacy: 'shared@x.test' });
  });

  it('maps a blank type to every domain', async () => {
    const p = await dbAtBefore('blank');
    const id = await seedCoordinator(p, 'blank-type', {
      email: 'b@x.test',
      phone: '+919200000030',
      type: '  ',
    });
    await seedLedger(p, {
      subjectType: 'aggregator',
      subjectId: id,
      acceptedAt: '2026-01-01T00:00:00Z',
    });
    await migrate(drizzle(p), { migrationsFolder: MIGRATIONS_DIR });
    const r = await one<{ serves: string[] }>(p, `SELECT serves FROM users WHERE id = $1`, [id]);
    expect(r.serves).toEqual([]);
  });

  it('refuses the first run when contact_extra holds data the new column cannot take', async () => {
    const p = await dbAtBefore('extra');
    await seedCoordinator(p, 'extra', {
      email: 'e@x.test',
      phone: '+919200000040',
      contactExtra: { alternatePhone: 9876543210 },
    });
    await expect(migrate(drizzle(p), { migrationsFolder: MIGRATIONS_DIR })).rejects.toThrow();
    const t = await one<{ t: string | null }>(
      p,
      `SELECT to_regclass('public.consent_record')::text AS t`,
    );
    expect(t.t).toBeNull();
  });
});
