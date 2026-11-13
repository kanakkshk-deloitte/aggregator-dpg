/**
 * Integration test for `scripts/sql/instance-upgrade-check.sql` (`@aggregator-dpg/api`,
 * the instance-upgrade operator tool): on a database at 0022, every drain and
 * pre-flight finding is seeded on its own — inside a transaction that is
 * rolled back — and the script must report exactly it. A clean 0022 database
 * has no blocker, and every check carries the category the runbook gives it.
 *
 * Skipped unless `INTEGRATION_DATABASE_URL` is set; the URL is only used to
 * CREATE / DROP a scratch database (`trnck_<random>`), so its role needs
 * CREATEDB.
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
import { runChecks, type CheckRow } from '../instance-upgrade-db.js';

const adminUrl = process.env.INTEGRATION_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '../../../drizzle/migrations');
const CHECK_SQL = path.resolve(HERE, '../../../../../scripts/sql/instance-upgrade-check.sql');
const LAST_BEFORE_IDX = 22;
const TIMEOUT_MS = 120_000;

const CONSENT = `'{"value":true,"given_at":"2026-02-01T10:00:00Z","valid_till":"2027-02-01T10:00:00Z"}'`;

/** A coordinator insert in the 0022 shape. */
function coordinator(
  slug: string,
  email: string,
  phone: string,
  extra: { type?: string; parent?: string; url?: string; status?: string; consent?: string } = {},
): string {
  const contact = JSON.stringify({ name: 'P', email, phone });
  return `INSERT INTO aggregators (org_slug, name, type, actor_type, url, contact, consent, status,
                                   parent_org_id, created_by, updated_by)
          VALUES ('${slug}', '${slug}', ${extra.type ? `'${extra.type}'` : 'NULL'}, 'aggregator',
                  ${extra.url ? `'${extra.url}'` : 'NULL'}, '${contact}'::jsonb,
                  ${extra.consent ?? CONSENT}::jsonb, '${extra.status ?? 'active'}',
                  ${extra.parent ? `'${extra.parent}'` : 'NULL'}, 'it', 'it')`;
}

/** An org insert in the 0022 shape. */
function org(
  id: string,
  slug: string,
  owner: { email: string; phone?: string; sub?: string; name?: string; status?: string },
): string {
  return `INSERT INTO aggregator_orgs (id, slug, display_name, owner_email, owner_phone, owner_kc_sub, status)
          VALUES ('${id}', '${slug}', '${owner.name ?? slug}', '${owner.email}',
                  ${owner.phone ? `'${owner.phone}'` : 'NULL'}, ${owner.sub ? `'${owner.sub}'` : 'NULL'},
                  '${owner.status ?? 'active'}')`;
}

/** A registration ledger row for the coordinator with `slug`. */
function ledger(slug: string, subjectType = 'aggregator'): string {
  return `INSERT INTO aggregator_consent_record
            (subject_type, subject_id, terms_version, privacy_version, network, source, accepted_at)
          SELECT '${subjectType}', id, 1, 1, 'blue_dot', 'registration', now()
            FROM aggregators WHERE org_slug = '${slug}'`;
}

/** A bulk upload of the first coordinator, in `status`. */
function upload(status: string): string {
  return `INSERT INTO bulk_uploads (aggregator_id, participant_type, s3_key, status, schema_id,
                                    schema_version, uploaded_by)
          SELECT id, 'seeker', 'k/${status}', '${status}', 's', '1', id FROM aggregators LIMIT 1`;
}

const O1 = '00000000-0000-4000-8000-000000000001';
const O2 = '00000000-0000-4000-8000-000000000002';
const C_OK = (slug = 'c1', email = 'c1@x.test', phone = '+919200000001') => [
  coordinator(slug, email, phone),
  ledger(slug),
];

/** Every check and its category (docs/user-org-migration-runbook.md). */
const CATEGORIES: Record<string, 'blocker' | 'info'> = {
  'D1 coordinators_pending': 'blocker',
  'D2 orgs_pending': 'blocker',
  'D3 bulk_uploads_in_flight': 'blocker',
  'D4 campaign_jobs_in_flight': 'blocker',
  'D5 invites_pending': 'blocker',
  'D6 bulk_presigns_never_uploaded': 'info',
  'T0d server_older_than_14': 'blocker',
  'T0e no_temp_privilege': 'blocker',
  'T0b role_cannot_act_as_owner': 'blocker',
  'T0c names_taken': 'blocker',
  'F1 email_with_many_phones': 'blocker',
  'F1 phone_with_many_emails': 'blocker',
  'F2 non_canonical_phone': 'blocker',
  'F2 blank_email': 'blocker',
  'F3 owner_and_coordinator': 'info',
  'F4 orgs_renamed_for_default_or_root': 'info',
  'F4 rename_target_taken': 'blocker',
  'F5 actor_type_not_aggregator': 'info',
  'F6 orgs_without_usable_address': 'info',
  'F7 distinct_domain_values': 'info',
  'F8 coordinators_with_missing_org': 'blocker',
  'F10 consent_backfilled': 'info',
  'F10 backfill_network_unknown': 'blocker',
  'F10b consent_not_true': 'blocker',
  'F10b consent_bad_timestamp': 'blocker',
  'F10c contact_extra_unmovable': 'blocker',
  'F10d ledger_unknown_subject_type': 'blocker',
  'F11 owners_of_several_orgs': 'info',
  'F12 rows_to_migrate': 'info',
  'F12b database_mb': 'info',
  'F13 coordinators_seeing_org_values': 'info',
  'F14 coordinators_into_default': 'info',
  'F15 owner_with_several_subjects': 'blocker',
  'F15b subject_on_several_owners': 'blocker',
  'F16 unknown_dependent_objects': 'blocker',
  'F16b dependents_outside_public': 'blocker',
  'F23 replication_or_cron_objects': 'info',
  'F18 participants_rows': 'info',
  'F22 aggregator_profile_with_data': 'blocker',
};

/** One finding: the rows that produce it, and the count expected. */
interface Case {
  check: string;
  seed: string[];
  n: number;
  /** The session network setting (as the tool sets it); unset when omitted. */
  network?: string;
}

const CASES: Case[] = [
  {
    check: 'D1 coordinators_pending',
    seed: [
      coordinator('c1', 'c1@x.test', '+919200000001', { status: 'pending' }),
      ...C_OK('c2', 'c2@x.test', '+919200000002'),
    ],
    n: 1,
  },
  {
    check: 'D2 orgs_pending',
    seed: [org(O1, 'o1', { email: 'a@x.test', status: 'pending' })],
    n: 1,
  },
  {
    check: 'D3 bulk_uploads_in_flight',
    seed: [
      ...C_OK(),
      upload('uploaded'),
      upload('file_validating'),
      upload('row_processing'),
      upload('finalising'),
      upload('completed'),
      upload('failed'),
      upload('file_failed'),
      upload('pending'),
    ],
    n: 4,
  },
  {
    check: 'D4 campaign_jobs_in_flight',
    seed: [
      ...C_OK(),
      `INSERT INTO campaign_job (aggregator_id, signalstack_org_id, channel, status, requested_by)
       SELECT id, 'sig-1', 'export', s::campaign_job_status, 'it'
         FROM aggregators, unnest(ARRAY['queued','processing','completed','failed']) s`,
    ],
    n: 2,
  },
  {
    check: 'D5 invites_pending',
    seed: [
      org(O1, 'o1', { email: 'a@x.test' }),
      `INSERT INTO registration_invites (parent_org_id, email, expires_at, created_by)
       VALUES ('${O1}', 'i@x.test', now() + interval '1 day', 'it')`,
      `INSERT INTO registration_invites (parent_org_id, email, status, expires_at, created_by)
       VALUES ('${O1}', 'j@x.test', 'consumed', now() + interval '1 day', 'it')`,
    ],
    n: 1,
  },
  {
    check: 'D5 invites_pending',
    seed: [
      org(O1, 'o1', { email: 'a@x.test' }),
      `INSERT INTO registration_invites (parent_org_id, email, expires_at, created_by)
       VALUES ('${O1}', 'old@x.test', now() - interval '1 day', 'it')`,
    ],
    n: 0,
  },
  {
    check: 'D6 bulk_presigns_never_uploaded',
    seed: [...C_OK(), upload('pending'), upload('completed')],
    n: 1,
  },
  { check: 'T0c names_taken', seed: ['CREATE TABLE contact (x int)'], n: 1 },
  {
    check: 'F1 email_with_many_phones',
    seed: [...C_OK(), org(O1, 'o1', { email: 'c1@x.test', phone: '+919300000001' })],
    n: 1,
  },
  {
    check: 'F1 phone_with_many_emails',
    seed: [...C_OK(), org(O1, 'o1', { email: 'other@x.test', phone: '+919200000001' })],
    n: 1,
  },
  { check: 'F2 non_canonical_phone', seed: C_OK('c1', 'c1@x.test', '98765 43210'), n: 1 },
  { check: 'F2 blank_email', seed: [org(O1, 'o1', { email: ' ' })], n: 1 },
  {
    check: 'F3 owner_and_coordinator',
    seed: [...C_OK(), org(O1, 'o1', { email: 'C1@x.test', phone: '+919200000001' })],
    n: 1,
  },
  {
    check: 'F4 orgs_renamed_for_default_or_root',
    seed: [
      org(O1, 'o1', { email: 'a@x.test', name: 'Default' }),
      org(O2, 'network', { email: 'a@x.test' }),
    ],
    n: 2,
  },
  {
    check: 'F4 rename_target_taken',
    seed: [
      org(O1, 'o1', { email: 'a@x.test', name: 'Default' }),
      org(O2, 'o2', { email: 'a@x.test', name: 'Default (o1)' }),
    ],
    n: 1,
  },
  {
    check: 'F5 actor_type_not_aggregator',
    seed: [
      `INSERT INTO aggregators (org_slug, name, type, actor_type, contact, consent, created_by, updated_by)
       VALUES ('s1', 's1', 'seeker', 'seeker',
               '{"name":"P","email":"s@x.test","phone":"+919200000005"}'::jsonb, ${CONSENT}::jsonb, 'it', 'it')`,
    ],
    n: 1,
  },
  { check: 'F6 orgs_without_usable_address', seed: [org(O1, 'o1', { email: 'a@x.test' })], n: 1 },
  {
    check: 'F7 distinct_domain_values',
    seed: [
      coordinator('c1', 'c1@x.test', '+919200000001', { type: 'seeker' }),
      coordinator('c2', 'c2@x.test', '+919200000002', { type: 'provider' }),
      coordinator('c3', 'c3@x.test', '+919200000003', { type: 'seeker' }),
    ],
    n: 2,
  },
  {
    check: 'F8 coordinators_with_missing_org',
    seed: [
      'ALTER TABLE aggregators DROP CONSTRAINT aggregators_parent_org_id_aggregator_orgs_id_fk',
      coordinator('c1', 'c1@x.test', '+919200000001', { parent: O2 }),
    ],
    n: 1,
  },
  {
    check: 'F10 consent_backfilled',
    seed: [...C_OK(), coordinator('c2', 'c2@x.test', '+919200000002')],
    n: 1,
  },
  {
    check: 'F10 backfill_network_unknown',
    seed: [coordinator('c1', 'c1@x.test', '+919200000001')],
    n: 1,
  },
  {
    check: 'F10 backfill_network_unknown',
    seed: [coordinator('c1', 'c1@x.test', '+919200000001')],
    n: 0,
    network: 'blue_dot',
  },
  {
    check: 'F10 backfill_network_unknown',
    seed: [...C_OK(), coordinator('c2', 'c2@x.test', '+919200000002')],
    n: 0,
  },
  {
    check: 'F10b consent_not_true',
    seed: [
      coordinator('c1', 'c1@x.test', '+919200000001', {
        consent: `'{"value":false,"given_at":"2026-02-01T10:00:00Z","valid_till":"2027-02-01T10:00:00Z"}'`,
      }),
    ],
    n: 1,
  },
  {
    check: 'F10b consent_bad_timestamp',
    seed: [
      coordinator('c1', 'c1@x.test', '+919200000001', {
        consent: `'{"value":true,"given_at":"not a date","valid_till":"2027-02-01T10:00:00Z"}'`,
      }),
    ],
    n: 1,
  },
  {
    check: 'F10b consent_bad_timestamp',
    seed: [
      coordinator('c1', 'c1@x.test', '+919200000001', {
        consent: `'{"value":true,"given_at":"2025-13-40T10:00:00Z","valid_till":"2027-02-01T10:00:00Z"}'`,
      }),
    ],
    n: 1,
  },
  {
    check: 'F10c contact_extra_unmovable',
    seed: [
      ...C_OK(),
      `UPDATE aggregators SET contact = contact || '{"fax":"1"}'::jsonb`,
      ...C_OK('c2', 'c2@x.test', '+919200000002'),
      `UPDATE aggregators SET contact = contact || '{"alternatePhone":919}'::jsonb WHERE org_slug = 'c2'`,
    ],
    n: 2,
  },
  { check: 'F10d ledger_unknown_subject_type', seed: [...C_OK(), ledger('c1', 'robot')], n: 1 },
  {
    check: 'F11 owners_of_several_orgs',
    seed: [
      org(O1, 'o1', { email: 'a@x.test', phone: '+919300000001' }),
      org(O2, 'o2', { email: 'A@x.test', phone: '+919300000001' }),
    ],
    n: 1,
  },
  { check: 'F12 rows_to_migrate', seed: C_OK(), n: 2 },
  {
    check: 'F13 coordinators_seeing_org_values',
    seed: [
      org(O1, 'o1', { email: 'a@x.test' }),
      coordinator('c1', 'c1@x.test', '+919200000001', { parent: O1, url: 'https://a.test' }),
      coordinator('c2', 'c2@x.test', '+919200000002', { parent: O1, url: 'https://b.test' }),
    ],
    n: 1,
  },
  {
    check: 'F14 coordinators_into_default',
    seed: [
      org(O1, 'o1', { email: 'a@x.test' }),
      ...C_OK(),
      coordinator('c2', 'c2@x.test', '+919200000002', { parent: O1 }),
    ],
    n: 1,
  },
  {
    check: 'F15 owner_with_several_subjects',
    seed: [
      org(O1, 'o1', { email: 'a@x.test', sub: 'kc-1' }),
      org(O2, 'o2', { email: 'a@x.test', sub: 'kc-2' }),
    ],
    n: 1,
  },
  {
    check: 'F15b subject_on_several_owners',
    seed: [
      org(O1, 'o1', { email: 'a@x.test', sub: 'kc-1' }),
      org(O2, 'o2', { email: 'b@x.test', sub: 'kc-1' }),
    ],
    n: 1,
  },
  {
    check: 'F16 unknown_dependent_objects',
    seed: [
      'CREATE VIEW v_coordinators AS SELECT id FROM aggregators',
      `CREATE FUNCTION count_coordinators() RETURNS bigint LANGUAGE sql AS 'SELECT count(*) FROM aggregators'`,
      'CREATE MATERIALIZED VIEW mv_one AS SELECT 1 AS x',
    ],
    n: 3,
  },
  {
    check: 'F16b dependents_outside_public',
    seed: [
      'CREATE SCHEMA reporting',
      'CREATE VIEW reporting.coordinators AS SELECT id FROM public.aggregators',
      'CREATE TABLE reporting.notes (aggregator_id uuid REFERENCES public.aggregators (id))',
      `CREATE FUNCTION reporting.n() RETURNS bigint LANGUAGE sql AS 'SELECT count(*) FROM public.aggregator_orgs'`,
    ],
    n: 3,
  },
  {
    check: 'F23 replication_or_cron_objects',
    seed: ['CREATE PUBLICATION iu_it_pub FOR TABLE aggregators'],
    n: 1,
  },
  {
    check: 'F18 participants_rows',
    seed: [
      ...C_OK(),
      `INSERT INTO participants (aggregator_id, type, participant_id)
       SELECT id, 'seeker', 'p1' FROM aggregators`,
    ],
    n: 1,
  },
  {
    check: 'F22 aggregator_profile_with_data',
    seed: [
      ...C_OK(),
      `INSERT INTO aggregator_profile (aggregator_id, created_by, updated_by)
       SELECT id, 'it', 'it' FROM aggregators`,
      ...C_OK('c2', 'c2@x.test', '+919200000002'),
      `INSERT INTO aggregator_profile (aggregator_id, contact_name, created_by, updated_by)
       SELECT id, 'kept', 'it', 'it' FROM aggregators WHERE org_slug = 'c2'`,
    ],
    n: 1,
  },
];

suite('instance-upgrade-check.sql at 0022 — integration', () => {
  let admin: pg.Client;
  let tmpDir: string;
  let dbName: string;
  let pool: pg.Pool;

  /** Seeds `seed` in a transaction, runs the checks, rolls back. */
  async function checkWith(seed: string[], network?: string): Promise<CheckRow[]> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (network) {
        await client.query(`SELECT set_config('aggregator_dpg.network', $1, true)`, [network]);
      }
      for (const stmt of seed) await client.query(stmt);
      return await runChecks(client, CHECK_SQL);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    const journal = JSON.parse(
      await readFile(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'),
    ) as { entries: Array<{ idx: number; tag: string }> } & Record<string, unknown>;
    const before = journal.entries.filter((e) => e.idx <= LAST_BEFORE_IDX);
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'trnck-'));
    const folder = path.join(tmpDir, 'migrations');
    await mkdir(path.join(folder, 'meta'), { recursive: true });
    for (const e of before) {
      await copyFile(path.join(MIGRATIONS_DIR, `${e.tag}.sql`), path.join(folder, `${e.tag}.sql`));
    }
    await writeFile(
      path.join(folder, 'meta/_journal.json'),
      JSON.stringify({ ...journal, entries: before }, null, 2),
    );
    dbName = `trnck_${randomBytes(4).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(adminUrl!);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 2 });
    // Teardown drops this scratch DB WITH (FORCE), which sends 57P01 to any
    // backend still attached; swallow it so it isn't an unhandled error that
    // fails the run after every test has already passed.
    pool.on('error', () => undefined);
    await migrate(drizzle(pool), { migrationsFolder: folder });
  }, TIMEOUT_MS);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    if (dbName) {
      await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
    }
    await admin?.end().catch(() => undefined);
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it('reports no blocker on a clean 0022 database', async () => {
    const rows = await checkWith([]);
    expect(rows.filter((r) => r.category !== 'info' && r.n > 0)).toEqual([]);
  });

  it('reports every check once, with the runbook category', async () => {
    const rows = await checkWith([]);
    expect(Object.fromEntries(rows.map((r) => [r.checkId, r.category]))).toEqual(CATEGORIES);
    expect(rows).toHaveLength(Object.keys(CATEGORIES).length);
  });

  it.each(
    CASES.map((c) => [`${c.check} = ${c.n}${c.network ? ' (network set)' : ''}`, c] as const),
  )('reports %s', async (_label, c) => {
    const rows = await checkWith(c.seed, c.network);
    expect(rows.find((r) => r.checkId === c.check)?.n).toBe(c.n);
  });
});
