/**
 * Integration test for migration 0028 (`organisations`, user & org refactor
 * Phase 3) against a live Postgres: a database at 0027 holding flat and
 * hierarchy data is upgraded, and every step's result is checked — the NF root
 * and Default org, the coordinators' org link, the org-detail adoption rule
 * and `legacy_org_details`, tenant `org_id`, `updated_at` untouched, and the
 * new constraints and triggers. Also covers the boot-time reconcile
 * (`reconcileRootOrganisations`) and the guard's data probe on the result.
 *
 * Skipped unless `INTEGRATION_DATABASE_URL` is set; the URL is only used to
 * CREATE / DROP scratch databases (`p3org_<random>`), so its role needs
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
import { hasRegistrationData } from '../migration-guards.js';
import { _setDbClients, closeDb, getDb, getPool } from '../client.js';
import { reconcileRootOrganisations } from '../../services/organisation-root.js';

const adminUrl = process.env.INTEGRATION_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../drizzle/migrations',
);
/** 0027 `users`: the state before this phase. */
const LAST_BEFORE_IDX = 27;
/** 0028 is the migration under test; later ones run in their own suites. */
const LAST_UNDER_TEST_IDX = 28;
const TIMEOUT_MS = 120_000;
const CONSENT = JSON.stringify({
  value: true,
  given_at: '2026-01-01T00:00:00.000Z',
  valid_till: '2027-01-01T00:00:00.000Z',
});
const STAMP = '2026-01-01T00:00:00.000Z';

/** A Beckn location with a street. */
const loc = (street: string, lng = 77.6, lat = 12.9) => [
  { geo: { type: 'Point', coordinates: [lng, lat] }, address: { streetAddress: street } },
];

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

/** Inserts a coordinator in the 0027 shape and returns its id. */
async function seedCoordinator(
  pool: pg.Pool,
  slug: string,
  p: {
    email: string;
    phone: string;
    parentOrgId?: string | null;
    status?: string;
    url?: string | null;
    locations?: unknown[];
    company?: string;
    gst?: string;
  },
): Promise<string> {
  await pool.query(
    `INSERT INTO contact (id, email, phone, name) VALUES (contact_id_of($1, $2), $1, $2, 'P')`,
    [p.email, p.phone],
  );
  const extra = {
    ...(p.company ? { company: p.company } : {}),
    ...(p.gst ? { gstNumber: p.gst } : {}),
  };
  const r = await one<{ id: string }>(
    pool,
    `INSERT INTO users (user_type, contact_id, signalstack_org_slug, signalstack_org_name, actor_type,
                        consent, url, locations, contact_extra, parent_org_id, status,
                        created_by, updated_by, created_at, updated_at)
     VALUES ('coordinator', contact_id_of($2, $3), $1, $1, 'aggregator', $4::jsonb, $5, $6::jsonb,
             $7::jsonb, $8, $9, 'it', 'it', $10, $10)
     RETURNING id`,
    [
      slug,
      p.email,
      p.phone,
      CONSENT,
      p.url ?? null,
      JSON.stringify(p.locations ?? []),
      JSON.stringify(extra),
      p.parentOrgId ?? null,
      p.status ?? 'active',
      STAMP,
    ],
  );
  return r.id;
}

/** Inserts an org (and its owner's admin account) in the 0027 shape. */
async function seedOrg(
  pool: pg.Pool,
  slug: string,
  p: { name?: string; email: string; state?: string; profile?: Record<string, unknown> },
): Promise<string> {
  await pool.query(
    `INSERT INTO contact (id, email) VALUES (contact_id_of($1, NULL), $1) ON CONFLICT DO NOTHING`,
    [p.email],
  );
  const admin = await one<{ id: string }>(
    pool,
    `INSERT INTO users (user_type, contact_id, status, locations, profile, contact_extra,
                        created_by, updated_by)
     VALUES ('admin', contact_id_of($1, NULL), NULL, NULL, NULL, NULL, 'it', 'it')
     ON CONFLICT (contact_id, user_type) DO UPDATE SET updated_by = 'it'
     RETURNING id`,
    [p.email],
  );
  const r = await one<{ id: string }>(
    pool,
    `INSERT INTO aggregator_orgs (slug, display_name, owner_user_id, state, profile, status)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'active') RETURNING id`,
    [slug, p.name ?? slug, admin.id, p.state ?? null, JSON.stringify(p.profile ?? {})],
  );
  return r.id;
}

suite('organisations (migration 0028) — integration', () => {
  let admin: pg.Client;
  let tmpDir: string;
  let beforeFolder: string;
  let upToFolder: string;
  const created: string[] = [];
  const pools: pg.Pool[] = [];
  let pool: pg.Pool;
  let poolUrl: string;
  const ids = {} as Record<
    | 'flat'
    | 'orgA'
    | 'a1'
    | 'a2'
    | 'orgB'
    | 'b1'
    | 'b2'
    | 'b3'
    | 'orgC'
    | 'c1'
    | 'c2'
    | 'named'
    | 'netName'
    | 'netSlug',
    string
  >;

  async function scratchDb(label: string): Promise<{ pool: pg.Pool; url: string }> {
    const name = `p3org_${label}_${randomBytes(4).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${name}`);
    created.push(name);
    const url = new URL(adminUrl!);
    url.pathname = `/${name}`;
    // The network the 0029 consent backfill records when the ledger is empty.
    const p = new pg.Pool({
      connectionString: url.toString(),
      max: 4,
      options: '-c aggregator_dpg.network=blue_dot',
    });
    // Teardown force-drops this scratch DB; swallow the 57P01 it sends an
    // attached backend so it isn't an unhandled error after tests pass.
    p.on('error', () => undefined);
    pools.push(p);
    return { pool: p, url: url.toString() };
  }

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    const journal = JSON.parse(
      await readFile(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'),
    ) as { entries: JournalEntry[] } & Record<string, unknown>;
    const before = journal.entries.filter((e) => e.idx <= LAST_BEFORE_IDX);
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'organisations-'));
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
    // The same folder pattern up to 0028, so this suite keeps asserting the
    // 0028 result (0029 has its own suite).
    upToFolder = path.join(tmpDir, 'migrations-0028');
    await mkdir(path.join(upToFolder, 'meta'), { recursive: true });
    const upTo = journal.entries.filter((e) => e.idx <= LAST_UNDER_TEST_IDX);
    for (const e of upTo) {
      await copyFile(
        path.join(MIGRATIONS_DIR, `${e.tag}.sql`),
        path.join(upToFolder, `${e.tag}.sql`),
      );
    }
    await writeFile(
      path.join(upToFolder, 'meta/_journal.json'),
      JSON.stringify({ ...journal, entries: upTo }, null, 2),
    );

    ({ pool, url: poolUrl } = await scratchDb('upgrade'));
    await migrate(drizzle(pool), { migrationsFolder: beforeFolder });

    // A formerly-flat coordinator with its own url / location / company.
    ids.flat = await seedCoordinator(pool, 'flat-1', {
      email: 'flat@x.test',
      phone: '+919100000001',
      url: 'https://flat.example',
      locations: loc('Flat street'),
      company: 'Flat Co',
    });
    // Org A has its own website + address + picked point; its coordinator differs.
    ids.orgA = await seedOrg(pool, 'org-a-1111', {
      email: 'owner.a@x.test',
      state: 'Karnataka',
      profile: {
        website: 'https://a.example',
        address: { streetAddress: 'A street', addressLocality: 'Blr', addressDistrict: 'Urban' },
        coordinates: [77.5, 12.97],
      },
    });
    ids.a1 = await seedCoordinator(pool, 'a1', {
      email: 'a1@x.test',
      phone: '+919100000002',
      parentOrgId: ids.orgA,
      url: 'https://a1.example',
      locations: loc('A1 street'),
    });
    // Org B has only a state: its active coordinators agree; a rejected one differs.
    ids.orgB = await seedOrg(pool, 'org-b-2222', { email: 'owner.b@x.test', state: 'Kerala' });
    ids.b1 = await seedCoordinator(pool, 'b1', {
      email: 'b1@x.test',
      phone: '+919100000003',
      parentOrgId: ids.orgB,
      url: 'https://b.example',
      locations: loc('B street'),
      company: 'B Ltd',
    });
    ids.b2 = await seedCoordinator(pool, 'b2', {
      email: 'b2@x.test',
      phone: '+919100000004',
      parentOrgId: ids.orgB,
      url: 'https://b.example',
      locations: loc('B street'),
      company: 'B Ltd',
    });
    ids.b3 = await seedCoordinator(pool, 'b3', {
      email: 'b3@x.test',
      phone: '+919100000005',
      parentOrgId: ids.orgB,
      status: 'inactive',
      url: 'https://spam.example',
    });
    // Org C: two active coordinators disagree, so nothing is adopted.
    ids.orgC = await seedOrg(pool, 'org-c-3333', { email: 'owner.c@x.test' });
    ids.c1 = await seedCoordinator(pool, 'c1', {
      email: 'c1@x.test',
      phone: '+919100000006',
      parentOrgId: ids.orgC,
      url: 'https://c1.example',
    });
    ids.c2 = await seedCoordinator(pool, 'c2', {
      email: 'c2@x.test',
      phone: '+919100000007',
      parentOrgId: ids.orgC,
      url: 'https://c2.example',
    });
    // A real org already named "Default", one named like the root's
    // placeholder, and one holding the root's placeholder slug.
    ids.named = await seedOrg(pool, 'default-4444', { name: 'Default', email: 'owner.d@x.test' });
    ids.netName = await seedOrg(pool, 'net-5555', { name: 'Network', email: 'owner.n@x.test' });
    ids.netSlug = await seedOrg(pool, 'network', { name: 'Net Slug Org', email: 'owner.s@x.test' });
    // A coordinator whose location is only the web's unresolved placeholder,
    // in an org that has a location: recorded verbatim so a revert is exact.
    ids.a2 = await seedCoordinator(pool, 'a2', {
      email: 'a2@x.test',
      phone: '+919100000008',
      parentOrgId: ids.orgA,
      locations: [{ geo: { type: 'Point', coordinates: [0, 0] }, address: {} }],
    });
    // Tenant rows.
    await pool.query(
      `INSERT INTO bulk_uploads (user_id, participant_type, s3_key, schema_id, schema_version, uploaded_by)
       VALUES ($1, 'seeker', 'k', 's', 'v1', $1)`,
      [ids.a1],
    );
    await pool.query(
      `INSERT INTO registration_links (user_id, slug, domain, created_by) VALUES ($1, 'l1', 'seeker', $1)`,
      [ids.flat],
    );

    await migrate(drizzle(pool), { migrationsFolder: upToFolder });
  }, TIMEOUT_MS);

  afterAll(async () => {
    await closeDb().catch(() => undefined);
    await Promise.allSettled(pools.map((p) => p.end()));
    for (const name of created) {
      await admin?.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
    }
    await admin?.end();
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  const org = (id: string) =>
    one<{ name: string; url: string | null; locations: unknown[]; legal_name: string | null }>(
      pool,
      'SELECT name, url, locations, legal_name FROM organisations WHERE id = $1',
      [id],
    );
  const user = (id: string) =>
    one<{ org_id: string; legacy_org_details: unknown; contact_extra: unknown }>(
      pool,
      'SELECT org_id, legacy_org_details, contact_extra FROM users WHERE id = $1',
      [id],
    );

  it('seeds exactly one NF root and the Default org under it', async () => {
    const r = await one<{ nf: number; nf_parent: boolean; def_parent_is_nf: boolean }>(
      pool,
      `SELECT (SELECT count(*)::int FROM organisations WHERE org_type = 'network_facilitator') AS nf,
              (SELECT parent_id IS NULL FROM organisations WHERE org_type = 'network_facilitator') AS nf_parent,
              (SELECT d.parent_id = n.id FROM organisations d, organisations n
                WHERE d.slug = 'default' AND n.org_type = 'network_facilitator') AS def_parent_is_nf`,
    );
    expect(r).toEqual({ nf: 1, nf_parent: true, def_parent_is_nf: true });
  });

  it('renames pre-existing orgs that would collide with Default or the root, keeping the originals', async () => {
    expect((await org(ids.named)).name).toBe('Default (default-4444)');
    expect((await org(ids.netName)).name).toBe('Network (net-5555)');
    const renamed = await one<{ slug: string; from: unknown }>(
      pool,
      `SELECT slug, profile -> 'renamed_from' AS from FROM organisations WHERE id = $1`,
      [ids.netSlug],
    );
    expect(renamed).toEqual({ slug: 'network-r1', from: { slug: 'network' } });
    const named = await one<{ from: unknown }>(
      pool,
      `SELECT profile -> 'renamed_from' AS from FROM organisations WHERE id = $1`,
      [ids.named],
    );
    expect(named.from).toEqual({ name: 'Default' });
  });

  it("records a coordinator's raw locations whenever they differ from the org's", async () => {
    // Its empty url differs from the org's too, so it is recorded as null.
    expect((await user(ids.a2)).legacy_org_details).toEqual({
      url: null,
      locations: [{ geo: { type: 'Point', coordinates: [0, 0] }, address: {} }],
    });
  });

  it('links every coordinator to an org; flat ones to Default', async () => {
    const d = await one<{ id: string }>(
      pool,
      `SELECT id FROM organisations WHERE slug = 'default'`,
    );
    expect((await user(ids.flat)).org_id).toBe(d.id);
    expect((await user(ids.a1)).org_id).toBe(ids.orgA);
    const nulls = await one<{ n: number }>(
      pool,
      `SELECT count(*)::int AS n FROM users WHERE user_type = 'coordinator' AND org_id IS NULL`,
    );
    expect(nulls.n).toBe(0);
  });

  it("keeps an org's own website and address (a Beckn location with its picked point)", async () => {
    const a = await org(ids.orgA);
    expect(a.url).toBe('https://a.example');
    expect(a.locations).toEqual([
      {
        geo: { type: 'Point', coordinates: [77.5, 12.97] },
        address: { streetAddress: 'A street', addressLocality: 'Blr', addressRegion: 'Karnataka' },
      },
    ]);
    // The coordinator's differing values are kept for it.
    expect((await user(ids.a1)).legacy_org_details).toEqual({
      url: 'https://a1.example',
      locations: loc('A1 street'),
    });
  });

  it('adopts the one value active coordinators agree on; never a state-only stub', async () => {
    const b = await org(ids.orgB);
    expect(b.url).toBe('https://b.example');
    expect(b.locations).toEqual(loc('B street'));
    expect(b.legal_name).toBe('B Ltd');
    // Agreeing coordinators keep nothing; the rejected one keeps its own url and
    // records its empty locations / company (so a revert restores them).
    expect((await user(ids.b1)).legacy_org_details).toBeNull();
    expect((await user(ids.b3)).legacy_org_details).toEqual({
      url: 'https://spam.example',
      locations: [],
      company: null,
    });
  });

  it('adopts nothing when active coordinators disagree', async () => {
    expect((await org(ids.orgC)).url).toBeNull();
    expect((await user(ids.c1)).legacy_org_details).toEqual({ url: 'https://c1.example' });
  });

  it('never adopts into the Default org; flat values stay on the coordinator', async () => {
    const d = await one<{ url: string | null; locations: unknown[] }>(
      pool,
      `SELECT url, locations FROM organisations WHERE slug = 'default'`,
    );
    expect(d).toEqual({ url: null, locations: [] });
    const flat = await user(ids.flat);
    expect(flat.legacy_org_details).toEqual({
      url: 'https://flat.example',
      locations: loc('Flat street'),
      company: 'Flat Co',
    });
    expect(flat.contact_extra).toEqual({});
  });

  it('drops the moved coordinator columns', async () => {
    const r = await one<{ n: number }>(
      pool,
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users'
          AND column_name IN ('url', 'locations', 'parent_org_id')`,
    );
    expect(r.n).toBe(0);
  });

  it("fills tenant org_id from the owner's org", async () => {
    const r = await one<{ bu: string; rl: string; d: string }>(
      pool,
      `SELECT (SELECT org_id FROM bulk_uploads WHERE user_id = $1) AS bu,
              (SELECT org_id FROM registration_links WHERE user_id = $2) AS rl,
              (SELECT id FROM organisations WHERE slug = 'default') AS d`,
      [ids.a1, ids.flat],
    );
    expect(r.bu).toBe(ids.orgA);
    expect(r.rl).toBe(r.d);
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

  it('is a no-op when re-applied', async () => {
    const sql = await readFile(path.join(MIGRATIONS_DIR, '0028_organisations.sql'), 'utf8');
    const before = await one<{ s: string }>(
      pool,
      `SELECT md5(string_agg(id::text || slug || name || coalesce(url, '') || locations::text, ',' ORDER BY id)) AS s
         FROM organisations`,
    );
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(sql);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    const after = await one<{ s: string }>(
      pool,
      `SELECT md5(string_agg(id::text || slug || name || coalesce(url, '') || locations::text, ',' ORDER BY id)) AS s
         FROM organisations`,
    );
    expect(after.s).toBe(before.s);
  });

  it('enforces the new invariants', async () => {
    const nf = await one<{ id: string; org_owner: string }>(
      pool,
      `SELECT id, org_owner FROM organisations WHERE org_type = 'network_facilitator'`,
    );
    await expect(
      pool.query(
        `INSERT INTO organisations (slug, name, org_type, status, org_owner)
         VALUES ('nf2', 'NF2', 'network_facilitator', 'active', $1)`,
        [nf.org_owner],
      ),
    ).rejects.toThrow(/organisations_single_nf/);
    await expect(
      pool.query(`UPDATE organisations SET org_type = 'network_facilitator' WHERE id = $1`, [
        ids.orgC,
      ]),
    ).rejects.toThrow(/org_type is immutable/);
    await expect(
      pool.query(`UPDATE organisations SET slug = 'changed' WHERE id = $1`, [ids.orgC]),
    ).rejects.toThrow(/slug is immutable/);
    // The NF slug follows config.
    await pool.query(`UPDATE organisations SET slug = 'net-renamed' WHERE id = $1`, [nf.id]);
    await pool.query(`UPDATE organisations SET slug = 'network' WHERE id = $1`, [nf.id]);
    // A coordinator needs an org; an admin must not have one.
    await expect(
      pool.query(`UPDATE users SET org_id = NULL WHERE id = $1`, [ids.c1]),
    ).rejects.toThrow(/users_role_shape_chk/);
    await expect(
      pool.query(`UPDATE users SET org_id = $1 WHERE id = $2`, [ids.orgC, nf.org_owner]),
    ).rejects.toThrow(/users_role_shape_chk/);
    // A tenant insert without org_id gets its user's org.
    const ins = await one<{ org_id: string }>(
      pool,
      `INSERT INTO bulk_uploads (user_id, participant_type, s3_key, schema_id, schema_version, uploaded_by)
       VALUES ($1, 'seeker', 'k2', 's', 'v1', $1) RETURNING org_id`,
      [ids.c1],
    );
    expect(ins.org_id).toBe(ids.orgC);
  });

  describe("at the current head (the boot reconcile is today's app code)", () => {
    beforeAll(async () => {
      await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_DIR });
    }, TIMEOUT_MS);

    it('is at the head schema', async () => {
      const head = await one<{ n: number }>(
        pool,
        `SELECT count(*)::int AS n FROM information_schema.columns
          WHERE table_name = 'users' AND column_name = 'serves'`,
      );
      expect(head.n).toBe(1);
    });

    it('reconciles the root from config, and the probe still sees real data', async () => {
      _setDbClients(null, null);
      getPool({ url: poolUrl });
      const state = await reconcileRootOrganisations(
        {
          nfSlug: 'blue-dots',
          nfName: 'Blue Dots Network',
          nfLegalName: 'Blue Dots Foundation',
          nfOwnerEmail: 'ops@x.test',
          defaultOwnerEmail: 'default.owner@x.test',
        },
        getDb(),
      );
      expect(state?.root.slug).toBe('blue-dots');
      expect(state?.root.ownerEmail).toBe('ops@x.test');
      expect(state?.defaultOrg.ownerEmail).toBe('default.owner@x.test');
      // The placeholder owner and its contact are gone.
      const ph = await one<{ n: number }>(
        pool,
        `SELECT count(*)::int AS n FROM contact WHERE email = 'network-admin@nf.invalid'`,
      );
      expect(ph.n).toBe(0);
      // Idempotent.
      const again = await reconcileRootOrganisations(
        {
          nfSlug: 'blue-dots',
          nfName: 'Blue Dots Network',
          nfLegalName: 'Blue Dots Foundation',
          nfOwnerEmail: 'ops@x.test',
          defaultOwnerEmail: 'default.owner@x.test',
        },
        getDb(),
      );
      expect(again?.changed).toEqual({
        slug: false,
        name: false,
        rootOwner: false,
        defaultOwner: false,
      });
      expect(await hasRegistrationData(pool as never)).toBe(true);
    });

    it('hands the root to an existing org owner and releases the previous owner', async () => {
      const before = await one<{ owner: string }>(
        pool,
        'SELECT org_owner AS owner FROM organisations WHERE id = $1',
        [ids.orgC],
      );
      const state = await reconcileRootOrganisations(
        {
          nfSlug: 'blue-dots',
          nfName: 'Blue Dots Network',
          nfLegalName: 'Blue Dots Foundation',
          nfOwnerEmail: 'owner.c@x.test',
          defaultOwnerEmail: 'default.owner@x.test',
        },
        getDb(),
      );
      // The existing admin account is reused, not duplicated; it keeps its org.
      expect(state?.root.ownerUserId).toBe(before.owner);
      expect(state?.changed.rootOwner).toBe(true);
      const after = await one<{ owner: string }>(
        pool,
        'SELECT org_owner AS owner FROM organisations WHERE id = $1',
        [ids.orgC],
      );
      expect(after.owner).toBe(before.owner);
      // ops@x.test owned only the root: its account and contact are released.
      const ops = await one<{ n: number }>(
        pool,
        `SELECT count(*)::int AS n FROM contact WHERE email = 'ops@x.test'`,
      );
      expect(ops.n).toBe(0);
    });
  });

  it('a fresh database reads as empty after 0028 and the root reconcile', async () => {
    const fresh = await scratchDb('fresh');
    await migrate(drizzle(fresh.pool), { migrationsFolder: MIGRATIONS_DIR });
    await closeDb();
    _setDbClients(null, null);
    getPool({ url: fresh.url });
    await reconcileRootOrganisations(
      {
        nfSlug: null,
        nfName: null,
        nfLegalName: null,
        nfOwnerEmail: 'ops@x.test',
        defaultOwnerEmail: null,
      },
      getDb(),
    );
    expect(await hasRegistrationData(fresh.pool as never)).toBe(false);
  });
});
