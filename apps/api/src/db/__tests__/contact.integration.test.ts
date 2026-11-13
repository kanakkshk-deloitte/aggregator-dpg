/**
 * Integration test for migration 0025 (`contact`) and the contact-aware stores,
 * against a live Postgres.
 *
 * Covers what the unit tests cannot: the SQL itself. Idempotent re-runs (the
 * pre-deploy script + the boot re-run), concurrent runners, the golden-vector
 * match between `contactId()` and `contact_id_of()`, the best-effort sync /
 * re-key / GC triggers under LEGACY writes (what the running N-1 release
 * does), the backfill leaving `updated_at` alone, and both stores reading
 * through the `contact` join.
 *
 * Skipped unless `INTEGRATION_DATABASE_URL` is set (the vitest config
 * force-sets a placeholder `DATABASE_URL`). Point it at a scratch database the
 * test may migrate and write to; every row it creates is removed or rolled
 * back:
 *
 *   INTEGRATION_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/aggregator_it \
 *     pnpm --filter @aggregator-dpg/api exec vitest run src/db/__tests__/contact.integration.test.ts
 *
 * By default the database is migrated to the final schema, so the tests of
 * the expand phase (legacy writes through the 0025 sync triggers, re-applying
 * 0025) skip themselves. To run those, migrate a fresh database with only
 * 0000–0025 by setting INTEGRATION_MIGRATIONS_FOLDER to a copy of the
 * migrations folder without 0026 (and its journal entry).
 *
 * @module @aggregator-dpg/api
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { contactId } from '@aggregator-dpg/shared-primitives/contact';
import { getDb, getPool, closeDb, _setDbClients } from '../client.js';
import { PostgresUserStore } from '../../services/user-store/postgres.js';
import { PostgresOrganisationStore } from '../../services/organisation-store/postgres.js';
import { permissiveTreeRules } from '../../services/organisation-store/testing.js';
import { NO_CONSENT_WRITE } from '../../services/consent-ledger/hook.js';

const realUrl = process.env.INTEGRATION_DATABASE_URL;
const suite = realUrl ? describe : describe.skip;

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../drizzle/migrations',
);
// The folder `beforeAll` migrates with. Defaults to all migrations (the final
// schema). Point it at a copy holding only 0000–0025 to exercise the expand
// phase (legacy columns + sync triggers) instead.
const MIGRATE_FROM = process.env.INTEGRATION_MIGRATIONS_FOLDER ?? MIGRATIONS_DIR;
const CONSENT = {
  value: true,
  given_at: '2026-01-01T00:00:00.000Z',
  valid_till: '2027-01-01T00:00:00.000Z',
};

/** Unique, canonical test phone — `+91` + 10 digits. */
function phone(): string {
  return `+91${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`;
}

suite('contact (migration 0025) — integration', () => {
  let pool: pg.Pool;
  let sql0025: string;
  let sql0026: string;
  let legacy = false;
  let headSchema = false;
  /** The Default org (0028): every coordinator needs an org. */
  let defaultOrgId = '';

  beforeAll(async () => {
    _setDbClients(null, null);
    getPool({ url: realUrl! });
    await migrate(getDb(), { migrationsFolder: MIGRATE_FROM });
    pool = new pg.Pool({ connectionString: realUrl, max: 4 });
    sql0025 = await readFile(path.join(MIGRATIONS_DIR, '0025_contact.sql'), 'utf8');
    sql0026 = await readFile(path.join(MIGRATIONS_DIR, '0026_contact_drop_legacy.sql'), 'utf8');
    // Once 0026 has run, the legacy columns and the sync triggers are gone:
    // the tests that exercise them (N-1 writes, re-applying 0025) no longer
    // apply and skip themselves.
    const r = await pool.query(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'aggregators' AND column_name = 'contact'`,
    );
    legacy = r.rows[0].n > 0;
    // The store tests run the current store code, which targets `users`
    // (migration 0028): they run only once `organisations` exists.
    const head = await pool.query(`SELECT to_regclass('public.organisations')::text AS t`);
    headSchema = Boolean(head.rows[0].t);
    if (headSchema) {
      const d = await pool.query(`SELECT id FROM organisations WHERE slug = 'default'`);
      defaultOrgId = d.rows[0]?.id ?? '';
    }
  });

  afterAll(async () => {
    await pool?.end();
    await closeDb();
  });

  /** Runs `fn` in a transaction that is always rolled back. */
  async function inRollback<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      return await fn(c);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }

  /** Applies 0025 exactly as `scripts/contact-migrate.sh apply` does. */
  async function apply0025(): Promise<void> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(sql0025);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  async function objectDefs(): Promise<string[]> {
    const r = await pool.query<{ d: string }>(`
      SELECT pg_get_triggerdef(t.oid) AS d FROM pg_trigger t
       WHERE NOT t.tgisinternal AND t.tgname LIKE '%contact%'
      UNION ALL
      SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
       WHERE c.conname LIKE '%contact%'
      ORDER BY 1`);
    return r.rows.map((x) => x.d);
  }

  it('is idempotent: re-applying 0025 twice changes nothing and raises nothing', async (ctx) => {
    if (!legacy) ctx.skip();
    const before = await objectDefs();
    await apply0025();
    await apply0025();
    expect(await objectDefs()).toEqual(before);
    const marker = await pool.query<{ m: string }>(
      `SELECT obj_description('public.contact'::regclass, 'pg_class') AS m`,
    );
    expect(marker.rows[0]!.m).toBe('contact-schema:v1');
  });

  it('serialises concurrent runners on the advisory lock (both succeed)', async (ctx) => {
    if (!legacy) ctx.skip();
    await expect(Promise.all([apply0025(), apply0025()])).resolves.toBeDefined();
  });

  it('contact_id_of() matches contactId() on the golden vectors', async () => {
    const vectors: Array<[string, string | null]> = [
      ['asha@example.org', '+919876543210'],
      ['owner@example.org', null],
      ['ZOË@example.org', '+919876543210'],
    ];
    for (const [email, ph] of vectors) {
      const r = await pool.query<{ id: string }>('SELECT contact_id_of($1, $2) AS id', [email, ph]);
      expect(r.rows[0]!.id).toBe(contactId(email, ph));
    }
  });

  describe('sync triggers under legacy (N-1) writes', () => {
    const insertCoordinator = (c: pg.PoolClient, slug: string, contact: object) =>
      c.query(
        `INSERT INTO aggregators (org_slug, actor_type, name, contact, consent, created_by, updated_by)
         VALUES ($1, 'aggregator', 'IT Org', $2, $3, 'it', 'it') RETURNING id, contact_id, contact_extra`,
        [slug, JSON.stringify(contact), JSON.stringify(CONSENT)],
      );

    it('links on insert, keeps extras, re-keys on a phone change, GCs on delete', (ctx) =>
      legacy
        ? inRollback(async (c) => {
            const email = `it-${randomUUID().slice(0, 8)}@example.org`;
            const p1 = phone();
            const p2 = phone();
            const ins = await insertCoordinator(c, `it-${randomUUID().slice(0, 8)}`, {
              name: 'Integration One',
              email: email.toUpperCase(),
              phone: p1,
              company: 'Acme',
            });
            const row = ins.rows[0] as { id: string; contact_id: string; contact_extra: object };
            expect(row.contact_id).toBe(contactId(email, p1));
            expect(row.contact_extra).toEqual({ company: 'Acme' });

            await c.query(
              `UPDATE aggregators SET contact = jsonb_set(contact, '{phone}', to_jsonb($2::text)) WHERE id = $1`,
              [row.id, p2],
            );
            const after = await c.query('SELECT contact_id FROM aggregators WHERE id = $1', [
              row.id,
            ]);
            expect(after.rows[0].contact_id).toBe(contactId(email, p2));
            const count = await c.query('SELECT count(*)::int AS n FROM contact WHERE email = $1', [
              email,
            ]);
            expect(count.rows[0].n).toBe(1);

            await c.query('DELETE FROM aggregators WHERE id = $1', [row.id]);
            const gone = await c.query('SELECT count(*)::int AS n FROM contact WHERE email = $1', [
              email,
            ]);
            expect(gone.rows[0].n).toBe(0);
          })
        : ctx.skip());

    it('keeps the legacy duplicate error (constraint name) for coordinator duplicates', (ctx) =>
      legacy
        ? inRollback(async (c) => {
            const email = `it-${randomUUID().slice(0, 8)}@example.org`;
            await insertCoordinator(c, `it-${randomUUID().slice(0, 8)}`, {
              name: 'A',
              email,
              phone: phone(),
            });
            await c.query('SAVEPOINT dup');
            const err = await insertCoordinator(c, `it-${randomUUID().slice(0, 8)}`, {
              name: 'B',
              email,
              phone: phone(),
            }).catch((e: { code?: string; constraint?: string }) => e);
            await c.query('ROLLBACK TO SAVEPOINT dup');
            expect((err as { code?: string }).code).toBe('23505');
            expect((err as { constraint?: string }).constraint).toBe(
              'aggregators_contact_email_unique',
            );
          })
        : ctx.skip());

    it('never fails a legacy write on a cross-role clash — leaves the row unlinked', (ctx) =>
      legacy
        ? inRollback(async (c) => {
            const shared = phone();
            await insertCoordinator(c, `it-${randomUUID().slice(0, 8)}`, {
              name: 'Coordinator',
              email: `it-${randomUUID().slice(0, 8)}@example.org`,
              phone: shared,
            });
            const org = await c.query(
              `INSERT INTO aggregator_orgs (slug, display_name, owner_email, owner_phone)
           VALUES ($1, $1, $2, $3) RETURNING contact_id`,
              [
                `it-org-${randomUUID().slice(0, 8)}`,
                `it-${randomUUID().slice(0, 8)}@example.org`,
                shared,
              ],
            );
            expect(org.rows[0].contact_id).toBeNull();
          })
        : ctx.skip());

    it('one person holding both roles shares a single contact row', (ctx) =>
      legacy
        ? inRollback(async (c) => {
            const email = `it-${randomUUID().slice(0, 8)}@example.org`;
            const p = phone();
            const a = await insertCoordinator(c, `it-${randomUUID().slice(0, 8)}`, {
              name: 'Both',
              email,
              phone: p,
            });
            const o = await c.query(
              `INSERT INTO aggregator_orgs (slug, display_name, owner_email, owner_phone)
           VALUES ($1, $1, $2, $3) RETURNING contact_id`,
              [`it-org-${randomUUID().slice(0, 8)}`, email, p],
            );
            expect(o.rows[0].contact_id).toBe(a.rows[0].contact_id);
          })
        : ctx.skip());
  });

  it('backfills an unlinked row on re-run without bumping updated_at', async (ctx) => {
    if (!legacy) ctx.skip();
    // A row written while the triggers were absent (e.g. by N-1 before the
    // pre-deploy script) — simulated by skipping triggers for one insert.
    const email = `it-${randomUUID().slice(0, 8)}@example.org`;
    const c = await pool.connect();
    let id: string;
    try {
      await c.query('SET session_replication_role = replica');
      const r = await c.query(
        `INSERT INTO aggregators (org_slug, actor_type, name, contact, consent, created_by, updated_by, updated_at)
         VALUES ($1, 'aggregator', 'IT Org', $2, $3, 'it', 'it', '2026-01-01T00:00:00Z') RETURNING id`,
        [
          `it-${randomUUID().slice(0, 8)}`,
          JSON.stringify({ name: 'Late', email, phone: phone() }),
          JSON.stringify(CONSENT),
        ],
      );
      id = r.rows[0].id;
      await c.query('SET session_replication_role = DEFAULT');
    } finally {
      c.release();
    }
    try {
      await apply0025();
      const r = await pool.query('SELECT contact_id, updated_at FROM aggregators WHERE id = $1', [
        id,
      ]);
      expect(r.rows[0].contact_id).not.toBeNull();
      expect(new Date(r.rows[0].updated_at).toISOString()).toBe('2026-01-01T00:00:00.000Z');
    } finally {
      await pool.query('DELETE FROM aggregators WHERE id = $1', [id]);
    }
  });

  describe('stores read through the contact join', () => {
    it('aggregator store composes the Beckn contact and finds by email/phone', async (ctx) => {
      // Store code is HEAD's: it needs HEAD's schema.
      if (!headSchema) ctx.skip();
      const store = new PostgresUserStore();
      const email = `it-${randomUUID().slice(0, 8)}@example.org`;
      const p = phone();
      const created = await store.create({
        recordConsent: NO_CONSENT_WRITE,
        orgSlug: `it-${randomUUID().slice(0, 8)}`,
        name: 'IT Org',
        type: null,
        contact: { name: 'Store Test', email, phone: p, gstNumber: 'GST1' },
        consent: CONSENT,
        createdBy: 'it',
        orgId: defaultOrgId,
        updatedBy: 'it',
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      try {
        expect(created.value.contactId).toBe(contactId(email, p));
        // GST belongs to the org since 0028: a submitted value is not stored,
        // and the Default org has none to render.
        expect(created.value.contact).toEqual({
          name: 'Store Test',
          email,
          phone: p,
        });
        const byEmail = await store.findByContactEmail(email.toUpperCase());
        expect(byEmail.ok && byEmail.value?.id).toBe(created.value.id);
        const byPhone = await store.findByContactPhone(p);
        expect(byPhone.ok && byPhone.value?.id).toBe(created.value.id);

        const p2 = phone();
        const updated = await store.update(created.value.id, {
          contact: { name: 'Store Test', email, phone: p2 },
          updatedBy: 'it',
        });
        expect(updated.ok && updated.value.contactId).toBe(contactId(email, p2));
        expect(updated.ok && updated.value.contactPhone).toBe(p2);
      } finally {
        await store.deleteById(created.value.id);
      }
    });

    it('org store persists the owner name and finds by owner phone', async (ctx) => {
      // Store code is HEAD's: it needs HEAD's schema.
      if (!headSchema) ctx.skip();
      const store = new PostgresOrganisationStore();
      const email = `it-${randomUUID().slice(0, 8)}@example.org`;
      const p = phone();
      const created = await store.create(
        {
          recordConsent: NO_CONSENT_WRITE,
          slug: `it-org-${randomUUID().slice(0, 8)}`,
          displayName: `IT Org ${randomUUID().slice(0, 8)}`,
          ownerEmail: email.toUpperCase(),
          ownerPhone: p,
          ownerName: 'Owner Name',
        },
        permissiveTreeRules(),
      );
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      try {
        expect(created.value.ownerEmail).toBe(email);
        expect(created.value.ownerName).toBe('Owner Name');
        expect(created.value.contactId).toBe(contactId(email, p));
        const byPhone = await store.findByOwnerPhone(p);
        expect(byPhone.ok && byPhone.value?.id).toBe(created.value.id);
      } finally {
        await store.deleteById(created.value.id);
        const left = await pool.query('SELECT count(*)::int AS n FROM contact WHERE email = $1', [
          email,
        ]);
        expect(left.rows[0].n).toBe(0);
      }
    });
  });

  describe('review fixes', () => {
    it('a failed re-key leaves no orphan contact behind (B1)', (ctx) =>
      legacy
        ? inRollback(async (c) => {
            const ownerPhone = phone();
            await c.query(
              `INSERT INTO aggregator_orgs (slug, display_name, owner_email, owner_phone)
           VALUES ($1, $1, $2, $3)`,
              [
                `it-org-${randomUUID().slice(0, 8)}`,
                `it-${randomUUID().slice(0, 8)}@example.org`,
                ownerPhone,
              ],
            );
            const email = `it-${randomUUID().slice(0, 8)}@example.org`;
            const ins = await c.query(
              `INSERT INTO aggregators (org_slug, actor_type, name, contact, consent, created_by, updated_by)
           VALUES ($1, 'aggregator', 'IT', $2, $3, 'it', 'it') RETURNING id`,
              [
                `it-${randomUUID().slice(0, 8)}`,
                JSON.stringify({ name: 'B1', email, phone: phone() }),
                JSON.stringify(CONSENT),
              ],
            );
            await c.query(
              `UPDATE aggregators SET contact = jsonb_set(contact, '{phone}', to_jsonb($2::text)) WHERE id = $1`,
              [ins.rows[0].id, ownerPhone],
            );
            const row = await c.query('SELECT contact_id FROM aggregators WHERE id = $1', [
              ins.rows[0].id,
            ]);
            expect(row.rows[0].contact_id).toBeNull();
            const left = await c.query('SELECT count(*)::int AS n FROM contact WHERE email = $1', [
              email,
            ]);
            expect(left.rows[0].n).toBe(0);
          })
        : ctx.skip());

    it('stores names verbatim, blank as NULL (M3)', (ctx) =>
      legacy
        ? inRollback(async (c) => {
            const padded = await c.query(`SELECT contact_link($1, $2, '  Asha  ') AS id`, [
              `it-${randomUUID().slice(0, 8)}@example.org`,
              phone(),
            ]);
            const blank = await c.query(`SELECT contact_link($1, $2, '   ') AS id`, [
              `it-${randomUUID().slice(0, 8)}@example.org`,
              phone(),
            ]);
            const names = await c.query('SELECT id, name FROM contact WHERE id = ANY($1)', [
              [padded.rows[0].id, blank.rows[0].id],
            ]);
            const byId = Object.fromEntries(
              names.rows.map((r: { id: string; name: string | null }) => [r.id, r.name]),
            );
            expect(byId[padded.rows[0].id]).toBe('  Asha  ');
            expect(byId[blank.rows[0].id]).toBeNull();
          })
        : ctx.skip());

    it('a legacy-written row reads back byte-identical to its jsonb (D9)', async (ctx) => {
      // Store code is HEAD's: it needs HEAD's schema.
      if (!headSchema) ctx.skip();
      if (!legacy) ctx.skip();
      const email = `it-${randomUUID().slice(0, 8)}@example.org`;
      const legacyContact = {
        name: ' Padded Name ',
        email,
        phone: phone(),
        company: 'Acme',
        gstNumber: 'G1',
      };
      const ins = await pool.query(
        `INSERT INTO aggregators (org_slug, actor_type, name, contact, consent, created_by, updated_by)
         VALUES ($1, 'aggregator', 'IT', $2, $3, 'it', 'it') RETURNING id, contact`,
        [`it-${randomUUID().slice(0, 8)}`, JSON.stringify(legacyContact), JSON.stringify(CONSENT)],
      );
      try {
        const found = await new PostgresUserStore().findById(ins.rows[0].id);
        expect(found.ok).toBe(true);
        if (!found.ok || !found.value) return;
        expect(JSON.stringify(found.value.contact)).toBe(JSON.stringify(ins.rows[0].contact));
      } finally {
        await pool.query('DELETE FROM aggregators WHERE id = $1', [ins.rows[0].id]);
      }
    });

    it('an app-written row serialises exactly as the legacy jsonb would have (D9)', async (ctx) => {
      // Store code is HEAD's: it needs HEAD's schema.
      if (!headSchema) ctx.skip();
      const store = new PostgresUserStore();
      const email = `it-${randomUUID().slice(0, 8)}@example.org`;
      const input = { name: 'Asha', email, phone: phone(), gstNumber: 'G1', company: 'Acme' };
      const created = await store.create({
        recordConsent: NO_CONSENT_WRITE,
        orgSlug: `it-${randomUUID().slice(0, 8)}`,
        name: 'IT Org',
        type: null,
        contact: input,
        consent: CONSENT,
        createdBy: 'it',
        orgId: defaultOrgId,
        updatedBy: 'it',
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      try {
        // What Postgres would have stored (and returned) for this object.
        // Company / GST belong to the org since 0028 (the Default org has none),
        // so the coordinator's contact carries only the person's own keys.
        const { gstNumber: _g, company: _c, ...own } = input;
        const asJsonb = await pool.query('SELECT $1::jsonb AS j', [JSON.stringify(own)]);
        expect(JSON.stringify(created.value.contact)).toBe(JSON.stringify(asJsonb.rows[0].j));
        const raw = await pool.query('SELECT contact_id FROM users WHERE id = $1', [
          created.value.id,
        ]);
        expect(raw.rows[0].contact_id).toBe(contactId(email, input.phone));
      } finally {
        await store.deleteById(created.value.id);
      }
    });

    it('app writes are strict: a second person with the same email is DUPLICATE_EMAIL', async (ctx) => {
      // Store code is HEAD's: it needs HEAD's schema.
      if (!headSchema) ctx.skip();
      const store = new PostgresUserStore();
      const email = `it-${randomUUID().slice(0, 8)}@example.org`;
      const base = {
        actorType: 'aggregator' as const,
        name: 'IT Org',
        type: null,
        consent: CONSENT,
        createdBy: 'it',
        orgId: defaultOrgId,
        updatedBy: 'it',
      };
      const first = await store.create({
        recordConsent: NO_CONSENT_WRITE,
        ...base,
        orgSlug: `it-${randomUUID().slice(0, 8)}`,
        contact: { name: 'A', email, phone: phone() },
      });
      expect(first.ok).toBe(true);
      const second = await store.create({
        recordConsent: NO_CONSENT_WRITE,
        ...base,
        orgSlug: `it-${randomUUID().slice(0, 8)}`,
        contact: { name: 'B', email, phone: phone() },
      });
      try {
        expect(second.ok).toBe(false);
        if (!second.ok) expect(second.error.code).toBe('DUPLICATE_EMAIL');
      } finally {
        if (first.ok) await store.deleteById(first.value.id);
      }
    });

    it('one coordinator row per person: the same email+phone twice is DUPLICATE_EMAIL', async (ctx) => {
      // Store code is HEAD's: it needs HEAD's schema.
      if (!headSchema) ctx.skip();
      const store = new PostgresUserStore();
      const person = {
        name: 'Twice',
        email: `it-${randomUUID().slice(0, 8)}@example.org`,
        phone: phone(),
      };
      const base = {
        actorType: 'aggregator' as const,
        name: 'IT Org',
        type: null,
        consent: CONSENT,
        createdBy: 'it',
        orgId: defaultOrgId,
        updatedBy: 'it',
      };
      const [a, b] = await Promise.all([
        store.create({
          recordConsent: NO_CONSENT_WRITE,
          ...base,
          orgSlug: `it-${randomUUID().slice(0, 8)}`,
          contact: person,
        }),
        store.create({
          recordConsent: NO_CONSENT_WRITE,
          ...base,
          orgSlug: `it-${randomUUID().slice(0, 8)}`,
          contact: person,
        }),
      ]);
      try {
        expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
        const loser = a.ok ? b : a;
        if (!loser.ok) expect(loser.error.code).toBe('DUPLICATE_EMAIL');
      } finally {
        if (a.ok) await store.deleteById(a.value.id);
        if (b.ok) await store.deleteById(b.value.id);
      }
    });

    it('refuses to re-key a contact shared by a coordinator and an org owner', async (ctx) => {
      // Store code is HEAD's: it needs HEAD's schema.
      if (!headSchema) ctx.skip();
      const email = `it-${randomUUID().slice(0, 8)}@example.org`;
      const p = phone();
      const aggStore = new PostgresUserStore();
      const orgStore = new PostgresOrganisationStore();
      const coord = await aggStore.create({
        recordConsent: NO_CONSENT_WRITE,
        orgSlug: `it-${randomUUID().slice(0, 8)}`,
        name: 'IT Org',
        type: null,
        contact: { name: 'Both', email, phone: p },
        consent: CONSENT,
        createdBy: 'it',
        orgId: defaultOrgId,
        updatedBy: 'it',
      });
      const org = await orgStore.create(
        {
          recordConsent: NO_CONSENT_WRITE,
          slug: `it-org-${randomUUID().slice(0, 8)}`,
          displayName: `IT Org ${randomUUID().slice(0, 8)}`,
          ownerEmail: email,
          ownerPhone: p,
        },
        permissiveTreeRules(),
      );
      if (!coord.ok || !org.ok) throw new Error('setup failed');
      try {
        expect(coord.value.contactId).toBe(org.value.contactId);
        const moved = await aggStore.update(coord.value.id, {
          contact: { name: 'Both', email, phone: phone() },
          updatedBy: 'it',
        });
        expect(moved.ok).toBe(false);
        if (!moved.ok) expect(moved.error.code).toBe('DUPLICATE');
        const orgAfter = await orgStore.findById(org.value.id);
        expect(orgAfter.ok && orgAfter.value?.ownerPhone).toBe(p);
      } finally {
        await aggStore.deleteById(coord.value.id);
        await orgStore.deleteById(org.value.id);
      }
    });

    it('email/phone lookups can use the indexes (M2)', async () => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL enable_seqscan = off');
        const plan = await c.query(
          `EXPLAIN SELECT a.id FROM users a LEFT JOIN contact c ON c.id = a.contact_id
            WHERE a.contact_id = (SELECT id FROM contact WHERE phone = $1)`,
          ['+910000000000'],
        );
        const text = plan.rows.map((r: Record<string, string>) => Object.values(r)[0]).join('\n');
        expect(text).not.toMatch(/Seq Scan on users/);
        expect(text).toMatch(/contact_phone_unique/);
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    });

    it('findByOwnerPhone matches contact_phone_unique (any status); deleting the org frees the phone', async (ctx) => {
      // Store code is HEAD's: it needs HEAD's schema.
      if (!headSchema) ctx.skip();
      const store = new PostgresOrganisationStore();
      const p = phone();
      const created = await store.create(
        {
          recordConsent: NO_CONSENT_WRITE,
          slug: `it-org-${randomUUID().slice(0, 8)}`,
          displayName: `IT Org ${randomUUID().slice(0, 8)}`,
          ownerEmail: `it-${randomUUID().slice(0, 8)}@example.org`,
          ownerPhone: p,
        },
        permissiveTreeRules(),
      );
      if (!created.ok) throw new Error('create failed');
      try {
        await store.update(created.value.id, { status: 'inactive' });
        const found = await store.findByOwnerPhone(p);
        expect(found.ok && found.value?.id).toBe(created.value.id);
        // A half-created org is deleted by the create route; the GC trigger
        // then frees its owner's phone for a retry.
        await store.deleteById(created.value.id);
        const gone = await store.findByOwnerPhone(p);
        expect(gone.ok && gone.value).toBeNull();
        const freed = await pool.query('SELECT 1 FROM contact WHERE phone = $1', [p]);
        expect(freed.rowCount).toBe(0);
      } finally {
        await store.deleteById(created.value.id);
      }
    });
  });

  describe('migration 0026 applied over the expand-phase schema', () => {
    it('drops the legacy columns over populated data and keeps every row linked', async (ctx) => {
      if (!legacy) ctx.skip();
      const email = `it-${randomUUID().slice(0, 8)}@example.org`;
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query(
          `INSERT INTO aggregators (org_slug, actor_type, name, contact, consent, created_by, updated_by)
           VALUES ($1, 'aggregator', 'IT', $2, $3, 'it', 'it')`,
          [
            `it-${randomUUID().slice(0, 8)}`,
            JSON.stringify({ name: 'Pre', email, phone: phone() }),
            JSON.stringify(CONSENT),
          ],
        );
        await c.query(sql0026);
        const cols = await c.query(
          `SELECT count(*)::int AS n FROM information_schema.columns
            WHERE table_name = 'aggregators' AND column_name IN ('contact', 'contact_phone', 'contact_email')`,
        );
        expect(cols.rows[0].n).toBe(0);
        const linked = await c.query(
          `SELECT c.email FROM aggregators a JOIN contact c ON c.id = a.contact_id WHERE c.email = $1`,
          [email],
        );
        expect(linked.rows).toHaveLength(1);
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    });

    it('refuses to run while a row is unlinked (the V1 gate)', async (ctx) => {
      if (!legacy) ctx.skip();
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL session_replication_role = replica');
        await c.query(
          `INSERT INTO aggregators (org_slug, actor_type, name, contact, consent, created_by, updated_by)
           VALUES ($1, 'aggregator', 'IT', $2, $3, 'it', 'it')`,
          [
            `it-${randomUUID().slice(0, 8)}`,
            JSON.stringify({
              name: 'Unlinked',
              email: `it-${randomUUID().slice(0, 8)}@example.org`,
              phone: phone(),
            }),
            JSON.stringify(CONSENT),
          ],
        );
        await c.query('SET LOCAL session_replication_role = DEFAULT');
        await expect(c.query(sql0026)).rejects.toThrow(/no contact_id/);
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    });
  });

  describe('migration 0026 (legacy columns dropped)', () => {
    it('removed the legacy columns and sync triggers, kept GC and made contact_id NOT NULL', async (ctx) => {
      if (legacy) ctx.skip();
      // After 0027 the only contact reference is users.contact_id (org owners
      // are admin accounts); the legacy columns stay gone.
      const cols = await pool.query(
        `SELECT table_name, column_name, is_nullable FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name IN ('users', 'aggregator_orgs')
            AND column_name IN ('contact', 'contact_phone', 'contact_email', 'owner_email', 'owner_phone', 'contact_id')`,
      );
      expect(cols.rows.map((r: { column_name: string }) => r.column_name).sort()).toEqual([
        'contact_id',
      ]);
      expect(cols.rows.every((r: { is_nullable: string }) => r.is_nullable === 'NO')).toBe(true);
      const trig = await pool.query(
        `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE '%contact%' ORDER BY 1`,
      );
      expect(trig.rows.map((r: { tgname: string }) => r.tgname)).toEqual([
        'contact_set_updated_at',
        'users_contact_ad',
      ]);
    });

    it('is idempotent: re-applying 0029 (the current head) is a no-op', async (ctx) => {
      if (legacy) ctx.skip();
      const head = await readFile(path.join(MIGRATIONS_DIR, '0029_cleanup.sql'), 'utf8');
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query(head);
        await c.query('COMMIT');
      } finally {
        c.release();
      }
    });

    it('still garbage-collects a contact when its last row is deleted', async (ctx) => {
      if (legacy) ctx.skip();
      const store = new PostgresUserStore();
      const email = `it-${randomUUID().slice(0, 8)}@example.org`;
      const created = await store.create({
        recordConsent: NO_CONSENT_WRITE,
        orgSlug: `it-${randomUUID().slice(0, 8)}`,
        name: 'IT Org',
        type: null,
        contact: { name: 'Gc', email, phone: phone() },
        consent: CONSENT,
        createdBy: 'it',
        orgId: defaultOrgId,
        updatedBy: 'it',
      });
      if (!created.ok) throw new Error('create failed');
      await store.deleteById(created.value.id);
      const left = await pool.query('SELECT count(*)::int AS n FROM contact WHERE email = $1', [
        email,
      ]);
      expect(left.rows[0].n).toBe(0);
    });
  });
  describe('app writes', () => {
    it("refuses to move a coordinator onto another person's contact (ContactTakenError)", async () => {
      const aggStore = new PostgresUserStore();
      const orgStore = new PostgresOrganisationStore();
      const ownerEmail = `it-${randomUUID().slice(0, 8)}@example.org`;
      const ownerPhone = phone();
      const org = await orgStore.create(
        {
          recordConsent: NO_CONSENT_WRITE,
          slug: `it-org-${randomUUID().slice(0, 8)}`,
          displayName: `IT Org ${randomUUID().slice(0, 8)}`,
          ownerEmail,
          ownerPhone,
          ownerName: 'Owner Name',
        },
        permissiveTreeRules(),
      );
      const coord = await aggStore.create({
        recordConsent: NO_CONSENT_WRITE,
        orgSlug: `it-${randomUUID().slice(0, 8)}`,
        name: 'IT Org',
        type: null,
        contact: {
          name: 'Intruder',
          email: `it-${randomUUID().slice(0, 8)}@example.org`,
          phone: phone(),
        },
        consent: CONSENT,
        createdBy: 'it',
        orgId: defaultOrgId,
        updatedBy: 'it',
      });
      if (!org.ok || !coord.ok) throw new Error('setup failed');
      try {
        const moved = await aggStore.update(coord.value.id, {
          contact: { name: 'Hijacked', email: ownerEmail, phone: ownerPhone },
          updatedBy: 'it',
        });
        expect(moved.ok).toBe(false);
        if (!moved.ok) expect(moved.error.code).toBe('DUPLICATE_EMAIL');
        const owner = await orgStore.findById(org.value.id);
        expect(owner.ok && owner.value?.ownerName).toBe('Owner Name');
      } finally {
        await aggStore.deleteById(coord.value.id);
        await orgStore.deleteById(org.value.id);
      }
    });
  });

  describe('legacy writes never merge people', () => {
    it("a legacy write never merges one person onto another person's contact", (ctx) =>
      legacy
        ? inRollback(async (c) => {
            const ownerEmail = `it-${randomUUID().slice(0, 8)}@example.org`;
            const ownerPhone = phone();
            await c.query(
              `INSERT INTO aggregator_orgs (slug, display_name, owner_email, owner_phone)
           VALUES ($1, $1, $2, $3)`,
              [`it-org-${randomUUID().slice(0, 8)}`, ownerEmail, ownerPhone],
            );
            await c.query(`UPDATE contact SET name = 'Owner Name' WHERE email = $1`, [ownerEmail]);
            const ins = await c.query(
              `INSERT INTO aggregators (org_slug, actor_type, name, contact, consent, created_by, updated_by)
           VALUES ($1, 'aggregator', 'IT', $2, $3, 'it', 'it') RETURNING id`,
              [
                `it-${randomUUID().slice(0, 8)}`,
                JSON.stringify({
                  name: 'Intruder',
                  email: `it-${randomUUID().slice(0, 8)}@example.org`,
                  phone: phone(),
                }),
                JSON.stringify(CONSENT),
              ],
            );
            // A legacy PATCH to exactly the owner's email + phone.
            await c.query(
              `UPDATE aggregators SET contact = jsonb_build_object('name', 'Intruder', 'email', $2::text, 'phone', $3::text)
            WHERE id = $1`,
              [ins.rows[0].id, ownerEmail, ownerPhone],
            );
            const row = await c.query('SELECT contact_id FROM aggregators WHERE id = $1', [
              ins.rows[0].id,
            ]);
            expect(row.rows[0].contact_id).toBeNull(); // left unlinked, not merged
            const owner = await c.query('SELECT name FROM contact WHERE email = $1', [ownerEmail]);
            expect(owner.rows[0].name).toBe('Owner Name'); // never renamed
          })
        : ctx.skip());
  });
});
