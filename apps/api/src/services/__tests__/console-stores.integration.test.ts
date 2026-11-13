/**
 * Integration test for the Phase 5 store methods against a live Postgres at
 * the head schema (`@aggregator-dpg/api`): the scoped, keyset-paged searches,
 * the per-org counts, the reject compare-and-set and the race-safe stale prune
 * (`deleteIfPending`, design C3).
 *
 * Skipped unless `INTEGRATION_DATABASE_URL` is set; the URL is only used to
 * CREATE / DROP a scratch database (`p5con_<random>`), so its role needs
 * CREATEDB.
 *
 * @module @aggregator-dpg/api
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { _setDbClients, closeDb, getPool } from '../../db/client.js';
import { PostgresUserStore, buildCreateCoordinatorInput } from '../user-store/index.js';
import { PostgresOrganisationStore } from '../organisation-store/index.js';
import { permissiveTreeRules } from '../organisation-store/testing.js';
import { NO_CONSENT_WRITE } from '../consent-ledger/hook.js';

const adminUrl = process.env.INTEGRATION_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../drizzle/migrations',
);
const TIMEOUT_MS = 120_000;

suite('console store methods (Postgres)', () => {
  let admin: pg.Client;
  let pool: pg.Pool;
  let dbName = '';
  const coordinators = new PostgresUserStore();
  const orgs = new PostgresOrganisationStore();
  const ids = { orgA: '', orgB: '', orgP: '', c1: '', c2: '', c3: '' };

  async function org(slug: string, name: string, email: string, phone: string): Promise<string> {
    const r = await orgs.create(
      {
        slug,
        displayName: name,
        ownerEmail: email,
        ownerPhone: phone,
        recordConsent: NO_CONSENT_WRITE,
      },
      permissiveTreeRules(),
    );
    if (!r.ok) throw new Error(`org seed failed: ${r.error.code}`);
    return r.value.id;
  }

  async function coordinator(n: number, orgId: string, type: string | null): Promise<string> {
    const r = await coordinators.create(
      buildCreateCoordinatorInput({
        orgSlug: `coord-${n}`,
        name: `Coordinator ${n}`,
        type,
        orgId,
        contact: { name: `C${n}`, email: `c${n}@x.test`, phone: `+9191000002${n}0` },
      }),
    );
    if (!r.ok) throw new Error(`coordinator seed failed: ${r.error.code}`);
    return r.value.id;
  }

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    dbName = `p5con_${randomBytes(4).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(adminUrl!);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({
      connectionString: url.toString(),
      max: 4,
      options: '-c aggregator_dpg.network=blue_dot',
    });
    // Teardown force-drops the database; a client still closing then gets
    // 57P01 from the server. Expected at that point, so never unhandled.
    pool.on('error', () => undefined);
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_DIR });
    _setDbClients(null, null);
    // Same guard on the app singleton pool: closeDb() ends it in teardown, but
    // the force-drop can still race a connection it holds.
    getPool({ url: url.toString() }).on('error', () => undefined);

    ids.orgA = await org('alpha-1111', 'Alpha', 'owner.a@x.test', '+919100000101');
    ids.orgB = await org('beta-2222', 'Beta', 'owner.b@x.test', '+919100000102');
    ids.orgP = await org('pending-3333', 'Pending Org', 'owner.p@x.test', '+919100000103');
    for (const id of [ids.orgA, ids.orgB]) {
      const approved = await orgs.approve(id, 'admin');
      if (!approved.ok || !approved.value) throw new Error('org approve failed');
    }
    ids.c1 = await coordinator(1, ids.orgA, 'seeker');
    ids.c2 = await coordinator(2, ids.orgA, null);
    ids.c3 = await coordinator(3, ids.orgB, 'provider');
    // Distinct creation instants, oldest first.
    for (const [i, id] of [ids.c1, ids.c2, ids.c3].entries()) {
      await pool.query(`UPDATE users SET created_at = $2 WHERE id = $1`, [
        id,
        new Date(Date.UTC(2026, 1, i + 1)),
      ]);
    }
    const active = await coordinators.approveFromPending(ids.c2, 'test');
    if (!active.ok || !active.value) throw new Error('coordinator approve failed');
  }, TIMEOUT_MS);

  afterAll(async () => {
    await closeDb().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    if (dbName) await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  describe('coordinator search', () => {
    it('scopes to the given orgs; an empty scope is an empty page', async () => {
      const a = await coordinators.search({ orgIds: [ids.orgA] });
      expect(a.ok && a.value.rows.map((r) => r.id)).toEqual([ids.c2, ids.c1]);
      const none = await coordinators.search({ orgIds: [] });
      expect(none.ok && none.value.rows).toEqual([]);
      const all = await coordinators.search({ orgIds: null });
      expect(all.ok && all.value.rows.map((r) => r.id)).toEqual([ids.c3, ids.c2, ids.c1]);
    });

    it('filters by status and by served domain ("every domain" matches any)', async () => {
      const pending = await coordinators.search({ orgIds: null, status: 'pending' });
      expect(pending.ok && pending.value.rows.map((r) => r.id).sort()).toEqual(
        [ids.c1, ids.c3].sort(),
      );
      const seekers = await coordinators.search({ orgIds: null, serves: 'seeker' });
      // c1 serves seeker; c2 serves every domain.
      expect(seekers.ok && seekers.value.rows.map((r) => r.id)).toEqual([ids.c2, ids.c1]);
    });

    it('pages by (created_at, id) without gaps or repeats', async () => {
      const first = await coordinators.search({ orgIds: null, limit: 2 });
      if (!first.ok) throw new Error('search failed');
      expect(first.value.rows.map((r) => r.id)).toEqual([ids.c3, ids.c2]);
      expect(first.value.nextCursor).not.toBeNull();
      const second = await coordinators.search({
        orgIds: null,
        limit: 2,
        cursor: first.value.nextCursor!,
      });
      expect(second.ok && second.value.rows.map((r) => r.id)).toEqual([ids.c1]);
      expect(second.ok && second.value.nextCursor).toBeNull();
    });

    it('loses no row that shares an instant with a page boundary (bulk inserts)', async () => {
      await pool.query(
        `UPDATE users SET created_at = '2026-03-01 00:00:00.123456+00' WHERE id = ANY($1::uuid[])`,
        [[ids.c1, ids.c2, ids.c3]],
      );
      const seen: string[] = [];
      let cursor: { createdAt: Date; id: string } | undefined;
      for (let i = 0; i < 5; i += 1) {
        const page = await coordinators.search({
          orgIds: null,
          limit: 1,
          ...(cursor ? { cursor } : {}),
        });
        if (!page.ok) throw new Error('search failed');
        seen.push(...page.value.rows.map((r) => r.id));
        if (!page.value.nextCursor) break;
        cursor = page.value.nextCursor;
      }
      expect(seen.sort()).toEqual([ids.c1, ids.c2, ids.c3].sort());
    });

    it('counts coordinators and pending ones per org', async () => {
      const counts = await coordinators.countByOrg([ids.orgA, ids.orgB, ids.orgP]);
      expect(counts.ok && counts.value).toMatchObject({
        [ids.orgA]: { total: 2, pending: 1 },
        [ids.orgB]: { total: 1, pending: 1 },
      });
    });
  });

  describe('org search and ownership', () => {
    it('orders by name, filters by status and a case-insensitive prefix', async () => {
      const all = await orgs.search({ orgIds: null });
      const names = all.ok ? all.value.rows.map((o) => o.displayName) : [];
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
      const pending = await orgs.search({ orgIds: null, status: 'pending' });
      expect(pending.ok && pending.value.rows.map((o) => o.id)).toEqual([ids.orgP]);
      const al = await orgs.search({ orgIds: null, namePrefix: 'al' });
      expect(al.ok && al.value.rows.map((o) => o.id)).toEqual([ids.orgA]);
      const scoped = await orgs.search({ orgIds: [ids.orgB] });
      expect(scoped.ok && scoped.value.rows.map((o) => o.id)).toEqual([ids.orgB]);
    });

    it('treats a LIKE wildcard in the prefix literally', async () => {
      const r = await orgs.search({ orgIds: null, namePrefix: '%' });
      expect(r.ok && r.value.rows).toEqual([]);
    });

    it('lists the orgs an admin owns', async () => {
      const a = await orgs.findById(ids.orgA);
      if (!a.ok || !a.value) throw new Error('read failed');
      const owned = await orgs.listOwnedBy(a.value.ownerUserId);
      expect(owned.ok && owned.value.map((o) => o.id)).toEqual([ids.orgA]);
    });

    it('records the editor and refuses a duplicate name', async () => {
      const edited = await orgs.update(ids.orgA, {
        profileMerge: { website: 'https://a.example', gst_number: '27AAPFU0939F1ZV' },
        updatedBy: 'admin-x',
      });
      expect(edited.ok && edited.value.updatedBy).toBe('admin-x');
      expect(edited.ok && edited.value.profile['website']).toBe('https://a.example');
      // A merge keeps the other keys; null removes one.
      const removed = await orgs.update(ids.orgA, {
        profileMerge: { website: null },
        updatedBy: 'admin-x',
      });
      expect(removed.ok && removed.value.profile['website']).toBeUndefined();
      expect(removed.ok && removed.value.profile['gst_number']).toBe('27AAPFU0939F1ZV');
      const dup = await orgs.update(ids.orgA, { displayName: 'beta', updatedBy: 'admin-x' });
      expect(!dup.ok && dup.error.code).toBe('DUPLICATE_NAME');
    });
  });

  describe('reject compare-and-set', () => {
    it('wins once and stamps rejected_at; the second call loses', async () => {
      const first = await coordinators.rejectFromPending(ids.c3, 'admin-y');
      expect(first.ok && first.value?.status).toBe('inactive');
      expect(first.ok && first.value?.rejectedAt).toBeInstanceOf(Date);
      const second = await coordinators.rejectFromPending(ids.c3, 'admin-y');
      expect(second.ok && second.value).toBeNull();
    });
  });

  describe('deleteIfPending (stale prune)', () => {
    const future = () => new Date(Date.now() + 60_000);

    it('rolls the delete back when the Keycloak step fails', async () => {
      const r = await coordinators.deleteIfPending(ids.c1, future(), async () => false);
      expect(r.ok && r.value).toBe('aborted');
      const still = await coordinators.findById(ids.c1);
      expect(still.ok && still.value?.status).toBe('pending');
    });

    it('leaves a decided row alone', async () => {
      const r = await coordinators.deleteIfPending(ids.c2, future(), async () => true);
      expect(r.ok && r.value).toBe('not_pending');
    });

    it('leaves a row touched after the cutoff alone', async () => {
      const r = await coordinators.deleteIfPending(ids.c1, new Date(0), async () => true);
      expect(r.ok && r.value).toBe('not_pending');
    });

    it('holds the row while the Keycloak step runs: a concurrent approval finds it gone', async () => {
      const started: { approval?: ReturnType<typeof coordinators.approveFromPending> } = {};
      const r = await coordinators.deleteIfPending(ids.c1, future(), async () => {
        // Started while the delete holds the row lock; it waits for the commit.
        started.approval = coordinators.approveFromPending(ids.c1, 'admin-z');
        await new Promise((res) => setTimeout(res, 200));
        return true;
      });
      expect(r.ok && r.value).toBe('deleted');
      const approved = await started.approval!;
      expect(approved.ok && approved.value).toBeNull();
      const gone = await coordinators.findById(ids.c1);
      expect(gone.ok && gone.value).toBeNull();
    });

    it('never deletes the Default org', async () => {
      const def = await orgs.findDefault();
      if (!def.ok || !def.value) throw new Error('no Default');
      const r = await orgs.deleteIfPending(def.value.id, future(), async () => true);
      expect(r.ok && r.value).toBe('not_pending');
    });

    it('deletes a stale pending org', async () => {
      const r = await orgs.deleteIfPending(ids.orgP, future(), async () => true);
      expect(r.ok && r.value).toBe('deleted');
      const gone = await orgs.findById(ids.orgP);
      expect(gone.ok && gone.value).toBeNull();
    });
  });
});
