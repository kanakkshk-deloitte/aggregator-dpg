/**
 * Integration test for the organisation store's tree rules against a live
 * Postgres at the head schema (`@aggregator-dpg/api`): limits on create and
 * revival, moves with the depth shift, "known as" values (defaults, resets,
 * the root list, the Default org), parent options, counts, and the tree lock
 * under concurrent writes.
 *
 * Skipped unless `INTEGRATION_DATABASE_URL` is set; the URL is only used to
 * CREATE / DROP a scratch database (`orgtree_<random>`), so its role needs
 * CREATEDB.
 *
 * @module @aggregator-dpg/api
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { _setDbClients, closeDb, getPool } from '../../../db/client.js';
import { PostgresOrganisationStore } from '../postgres.js';
import { permissiveTreeRules } from '../testing.js';
import { NO_CONSENT_WRITE } from '../../consent-ledger/hook.js';
import { knownAsKeyValid } from '../../known-as.js';
import type { KnownAsValues } from '@aggregator-dpg/shared-primitives/user-org';
import type { CreateOrgInput, OrgStoreResult } from '../interface.js';

const adminUrl = process.env.INTEGRATION_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../drizzle/migrations',
);
const TIMEOUT_MS = 120_000;

/** Waits `ms` milliseconds. */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const code = (r: OrgStoreResult<unknown>) => (r.ok ? 'ok' : r.error.code);

const STATE = { key: 'state', name: 'State' };
const BLOCK = { key: 'block', name: 'Block' };
const TALUK = { key: 'taluk', name: 'Taluk' };
const WARD = { key: 'ward', name: 'Ward' };

suite('organisation store tree rules (Postgres)', () => {
  let admin: pg.Client;
  let pool: pg.Pool;
  let dbName = '';
  const store = new PostgresOrganisationStore();
  let rootId = '';
  let defaultId = '';

  const input = (slug: string, parentId?: string): CreateOrgInput => ({
    slug,
    displayName: slug.toUpperCase(),
    ownerEmail: `${slug}@x.test`,
    recordConsent: NO_CONSENT_WRITE,
    ...(parentId === undefined ? {} : { parentId }),
  });

  /** Creates an org under permissive tree rules, deep enough for the descendant walk cap, and sets its status. */
  async function org(
    slug: string,
    parentId?: string,
    status: 'active' | 'pending' | 'inactive' = 'active',
  ): Promise<string> {
    const r = await store.create(input(slug, parentId), permissiveTreeRules({ maxDepth: 64 }));
    if (!r.ok) throw new Error(`seed ${slug} failed: ${r.error.code}`);
    if (status === 'active') await store.approve(r.value.id, 'test');
    if (status === 'inactive') await store.reject(r.value.id, 'test');
    return r.value.id;
  }

  async function depthOf(id: string): Promise<[string | null, number]> {
    const r = await pool.query<{ parent_id: string | null; depth: number }>(
      'SELECT parent_id, depth FROM organisations WHERE id = $1',
      [id],
    );
    return [r.rows[0]!.parent_id, r.rows[0]!.depth];
  }

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    dbName = `orgtree_${randomBytes(4).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(adminUrl!);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({
      connectionString: url.toString(),
      max: 4,
      options: '-c aggregator_dpg.network=blue_dot',
    });
    pool.on('error', () => undefined);
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_DIR });
    _setDbClients(null, null);
    getPool({ url: url.toString() }).on('error', () => undefined);
    const root = await store.findRoot();
    const def = await store.findDefault();
    if (!root.ok || !root.value || !def.ok || !def.value)
      throw new Error('root or Default missing');
    rootId = root.value.id;
    defaultId = def.value.id;
  }, TIMEOUT_MS);

  beforeEach(async () => {
    await pool.query(
      `DELETE FROM organisations WHERE org_type = 'aggregator' AND slug <> 'default'`,
    );
    await pool.query('DELETE FROM org_known_as');
    await pool.query(
      `UPDATE organisations SET known_as = 'aggregator'
        WHERE org_type = 'network_facilitator' OR slug = 'default'`,
    );
  });

  /** Writes an org's `org_known_as` row directly, keys included, for test setup. */
  async function seedList(id: string, list: KnownAsValues): Promise<void> {
    await pool.query('DELETE FROM org_known_as WHERE org_id = $1', [id]);
    if (list.length === 0) return;
    await pool.query(
      `INSERT INTO org_known_as (org_id, known_as_values, created_at, updated_at, updated_by)
       VALUES ($1, $2::jsonb, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'seed')`,
      [id, JSON.stringify(list)],
    );
  }

  /** The org's `org_known_as` row, timestamps as text; undefined when it has none. */
  async function listRow(id: string) {
    const r = await pool.query<{
      known_as_values: KnownAsValues;
      created: string;
      updated: string;
      updated_by: string;
    }>(
      `SELECT known_as_values, created_at::text AS created, updated_at::text AS updated, updated_by
         FROM org_known_as WHERE org_id = $1`,
      [id],
    );
    return r.rows[0];
  }

  /** The stored list of an org, read through the store. */
  async function listOf(id: string): Promise<KnownAsValues | null> {
    const r = await store.knownAsValues(id);
    return r.ok ? r.value : null;
  }

  /** The stored key and updated_at of an org. */
  async function knownAsRow(id: string): Promise<[string, string]> {
    const r = await pool.query<{ known_as: string; updated_at: Date }>(
      'SELECT known_as, updated_at FROM organisations WHERE id = $1',
      [id],
    );
    return [r.rows[0]!.known_as, r.rows[0]!.updated_at.toISOString()];
  }

  afterAll(async () => {
    await closeDb().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    if (dbName) await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  describe('childIds and the parentId search filter', () => {
    it('return the direct children only, never a grandchild', async () => {
      const a = await org('a');
      const b = await org('b', a);
      const c = await org('c', b);
      const top = await store.childIds([rootId]);
      expect(top.ok && top.value).toEqual(expect.arrayContaining([a, defaultId]));
      expect(top.ok && top.value).not.toContain(b);
      const below = await store.childIds([a, b]);
      expect(below.ok && [...below.value].sort()).toEqual([b, c].sort());
      expect(await store.childIds([])).toEqual({ ok: true, value: [] });
      const page = await store.search({ orgIds: null, parentId: a });
      expect(page.ok && page.value.rows.map((o) => o.id)).toEqual([b]);
    });
  });

  describe('create', () => {
    it("sets depth from a nested parent and the parent's default known_as", async () => {
      const a = await org('a');
      const b = await org('b', a);
      await seedList(b, [BLOCK, { ...TALUK, default: true }]);
      const r = await store.create(input('n', b), permissiveTreeRules());
      expect(
        r.ok && [r.value.depth, r.value.knownAs, r.value.knownAsName, r.value.parentId],
      ).toEqual([3, 'taluk', 'Taluk', b]);
      const plain = await store.create(input('m', a), permissiveTreeRules());
      expect(plain.ok && [plain.value.knownAs, plain.value.knownAsName]).toEqual([
        'aggregator',
        'Aggregator',
      ]);
    });

    it("gives a top-level org the root's default", async () => {
      await seedList(rootId, [{ ...STATE, default: true }]);
      const r = await store.create(input('top'), permissiveTreeRules());
      expect(r.ok && [r.value.knownAs, r.value.knownAsName]).toEqual(['state', 'State']);
    });

    it('refuses INVALID_PARENT and DEPTH_LIMIT', async () => {
      const a = await org('a');
      expect(code(await store.create(input('n', defaultId), permissiveTreeRules()))).toBe(
        'INVALID_PARENT',
      );
      expect(code(await store.create(input('n', a), permissiveTreeRules({ maxDepth: 1 })))).toBe(
        'DEPTH_LIMIT',
      );
    });

    it('counts pending children, not rejected ones or the Default org', async () => {
      const c = await org('c');
      await org('p', c, 'pending');
      await org('x', c, 'inactive');
      expect(code(await store.create(input('n', c), permissiveTreeRules({ maxChildren: 1 })))).toBe(
        'CHILD_LIMIT',
      );
      // The root holds c and Default; only c counts.
      expect(code(await store.create(input('n'), permissiveTreeRules({ maxChildren: 2 })))).toBe(
        'ok',
      );
      expect(code(await store.create(input('m'), permissiveTreeRules({ maxChildren: 2 })))).toBe(
        'CHILD_LIMIT',
      );
    });

    it('refuses TOTAL_LIMIT counting pending orgs, not rejected ones or the Default org', async () => {
      await org('a');
      await org('p', undefined, 'pending');
      await org('x', undefined, 'inactive');
      expect(code(await store.create(input('n'), permissiveTreeRules({ maxTotalOrgs: 2 })))).toBe(
        'TOTAL_LIMIT',
      );
      expect(code(await store.create(input('n'), permissiveTreeRules({ maxTotalOrgs: 3 })))).toBe(
        'ok',
      );
    });

    it('lets one of two concurrent creates take the last child slot', async () => {
      const c = await org('c');
      const slow = (slug: string): CreateOrgInput => ({
        ...input(slug, c),
        recordConsent: () => sleep(200),
      });
      const results = await Promise.all([
        store.create(slow('r1'), permissiveTreeRules({ maxChildren: 1 })),
        store.create(slow('r2'), permissiveTreeRules({ maxChildren: 1 })),
      ]);
      expect(results.map(code).sort()).toEqual(['CHILD_LIMIT', 'ok']);
    });

    it('lets one of two concurrent creates take the last org slot', async () => {
      await org('a');
      const slow = (slug: string): CreateOrgInput => ({
        ...input(slug),
        recordConsent: () => sleep(200),
      });
      const results = await Promise.all([
        store.create(slow('r1'), permissiveTreeRules({ maxTotalOrgs: 2 })),
        store.create(slow('r2'), permissiveTreeRules({ maxTotalOrgs: 2 })),
      ]);
      expect(results.map(code).sort()).toEqual(['TOTAL_LIMIT', 'ok']);
    });
  });

  describe('revive', () => {
    it('sets a rejected org back to pending and clears rejected_at', async () => {
      const x = await org('x', undefined, 'inactive');
      const r = await store.revive(x, undefined, permissiveTreeRules());
      expect(r.ok && [r.value.status, r.value.rejectedAt]).toEqual(['pending', null]);
    });

    it('revives under the submitted parent and sets parent and depth from it', async () => {
      const a = await org('a');
      const b = await org('b', a);
      const x = await org('x', undefined, 'inactive');
      const r = await store.revive(x, b, permissiveTreeRules());
      expect(r.ok && [r.value.parentId, r.value.parentName, r.value.depth]).toEqual([b, 'B', 3]);
      expect(await depthOf(x)).toEqual([b, 3]);
    });

    it('revives under the root when no parent is submitted', async () => {
      const a = await org('a');
      const x = await org('x', a, 'inactive');
      const r = await store.revive(x, undefined, permissiveTreeRules());
      expect(r.ok && [r.value.parentId, r.value.depth]).toEqual([rootId, 1]);
    });

    it('revives under a valid new parent when the stored parent is no longer active', async () => {
      const p = await org('p');
      const a = await org('a');
      const x = await org('x', p, 'inactive');
      await pool.query(`UPDATE organisations SET status = 'inactive' WHERE id = $1`, [p]);
      const r = await store.revive(x, a, permissiveTreeRules());
      expect(r.ok && [r.value.parentId, r.value.depth]).toEqual([a, 2]);
    });

    it("takes the new parent's default known_as, else aggregator", async () => {
      const a = await org('a');
      const b = await org('b', a);
      await seedList(a, [BLOCK, { ...TALUK, default: true }]);
      const x = await org('x', undefined, 'inactive');
      const y = await org('y', undefined, 'inactive');
      await pool.query(`UPDATE organisations SET known_as = 'block' WHERE id IN ($1, $2)`, [x, y]);
      const underA = await store.revive(x, a, permissiveTreeRules());
      expect(underA.ok && underA.value.knownAs).toBe('taluk');
      const underB = await store.revive(y, b, permissiveTreeRules());
      expect(underB.ok && [underB.value.depth, underB.value.knownAs]).toEqual([3, 'aggregator']);
    });

    it('refuses CHILD_LIMIT, TOTAL_LIMIT, DEPTH_LIMIT and INVALID_PARENT', async () => {
      const c = await org('c');
      await org('y', c);
      const x = await org('x', undefined, 'inactive');
      expect(code(await store.revive(x, c, permissiveTreeRules({ maxChildren: 1 })))).toBe(
        'CHILD_LIMIT',
      );
      expect(code(await store.revive(x, c, permissiveTreeRules({ maxTotalOrgs: 2 })))).toBe(
        'TOTAL_LIMIT',
      );
      expect(code(await store.revive(x, c, permissiveTreeRules({ maxDepth: 1 })))).toBe(
        'DEPTH_LIMIT',
      );
      expect(code(await store.revive(x, defaultId, permissiveTreeRules()))).toBe('INVALID_PARENT');
      await pool.query(`UPDATE organisations SET status = 'inactive' WHERE id = $1`, [c]);
      expect(code(await store.revive(x, c, permissiveTreeRules()))).toBe('INVALID_PARENT');
      const still = await store.findById(x);
      expect(still.ok && [still.value?.status, still.value?.parentId]).toEqual([
        'inactive',
        rootId,
      ]);
    });

    it('refuses NOT_MOVABLE when the rejected org has child orgs', async () => {
      const a = await org('a');
      const x = await org('x', undefined, 'inactive');
      const z = await org('z');
      await pool.query(`UPDATE organisations SET parent_id = $1, depth = 2 WHERE id = $2`, [x, z]);
      expect(code(await store.revive(x, a, permissiveTreeRules()))).toBe('NOT_MOVABLE');
    });

    it('answers NOT_FOUND for an unknown or not rejected org', async () => {
      const a = await org('a');
      expect(code(await store.revive(a, undefined, permissiveTreeRules()))).toBe('NOT_FOUND');
      expect(
        code(
          await store.revive(
            '00000000-0000-0000-0000-000000000000',
            undefined,
            permissiveTreeRules(),
          ),
        ),
      ).toBe('NOT_FOUND');
    });
  });

  describe('move', () => {
    it('moves an org and shifts the depth of its subtree', async () => {
      const a = await org('a');
      const b = await org('b', a);
      const c = await org('c');
      const r = await store.move(a, { parentId: c }, permissiveTreeRules());
      expect(r.ok && [r.value.movedCount, r.value.org.parentName, r.value.org.depth]).toEqual([
        2,
        'C',
        2,
      ]);
      expect(await depthOf(a)).toEqual([c, 2]);
      expect(await depthOf(b)).toEqual([a, 3]);
      expect(r.ok && r.value.oldParentId).toBe(rootId);
      const back = await store.move(b, { parentId: rootId }, permissiveTreeRules());
      expect(back.ok && back.value.org.depth).toBe(1);
    });

    it('refuses PARENT_CYCLE, INVALID_PARENT and NOT_MOVABLE', async () => {
      const a = await org('a');
      const b = await org('b', a);
      const x = await org('x', undefined, 'inactive');
      expect(code(await store.move(a, { parentId: b }, permissiveTreeRules()))).toBe(
        'PARENT_CYCLE',
      );
      expect(code(await store.move(a, { parentId: a }, permissiveTreeRules()))).toBe(
        'PARENT_CYCLE',
      );
      expect(code(await store.move(a, { parentId: defaultId }, permissiveTreeRules()))).toBe(
        'INVALID_PARENT',
      );
      expect(code(await store.move(defaultId, { parentId: a }, permissiveTreeRules()))).toBe(
        'NOT_MOVABLE',
      );
      expect(code(await store.move(x, { parentId: a }, permissiveTreeRules()))).toBe('NOT_MOVABLE');
    });

    it('counts the subtree height against max depth, and refuses a full parent', async () => {
      const a = await org('a');
      const b = await org('b', a);
      const c = await org('c');
      expect(code(await store.move(a, { parentId: c }, permissiveTreeRules({ maxDepth: 2 })))).toBe(
        'DEPTH_LIMIT',
      );
      await org('y', c);
      expect(
        code(await store.move(b, { parentId: c }, permissiveTreeRules({ maxChildren: 1 }))),
      ).toBe('CHILD_LIMIT');
    });

    it('keeps a key the new parent has or aggregator, resets any other; orgs below keep theirs', async () => {
      const a = await org('a');
      const b = await org('b', a);
      const deep = await org('deep', b);
      const c = await org('c');
      const e = await org('e');
      await seedList(a, [BLOCK, TALUK]);
      await seedList(c, [BLOCK, { ...WARD, default: true }]);
      await seedList(e, [TALUK]);
      await seedList(b, [{ key: 'unit', name: 'Unit' }]);
      await store.setKnownAs(b, 'block', a, 'test');
      await store.setKnownAs(deep, 'unit', b, 'test');
      const kept = await store.move(b, { parentId: c }, permissiveTreeRules());
      expect(kept.ok && [kept.value.org.knownAs, kept.value.org.knownAsName]).toEqual([
        'block',
        'Block',
      ]);
      const reset = await store.move(b, { parentId: e }, permissiveTreeRules());
      expect(reset.ok && reset.value.org.knownAs).toBe('aggregator');
      const keptSystem = await store.move(b, { parentId: c }, permissiveTreeRules());
      expect(keptSystem.ok && keptSystem.value.org.knownAs).toBe('aggregator');
      await store.move(b, { parentId: e }, permissiveTreeRules());
      await store.setKnownAs(b, 'taluk', e, 'test');
      const toDefault = await store.move(b, { parentId: c }, permissiveTreeRules());
      expect(toDefault.ok && toDefault.value.org.knownAs).toBe('ward');
      const d = await store.findById(deep);
      expect(d.ok && [d.value?.knownAs, d.value?.knownAsName, d.value?.depth]).toEqual([
        'unit',
        'Unit',
        3,
      ]);
    });

    it('is a no-op for the current parent', async () => {
      const a = await org('a');
      await pool.query(`UPDATE organisations SET known_as = 'gone' WHERE id = $1`, [a]);
      const same = await store.move(a, { parentId: rootId }, permissiveTreeRules());
      expect(same.ok && [same.value.movedCount, same.value.org.knownAs]).toEqual([0, 'gone']);
    });

    it('answers ORG_BUSY at once when another transaction holds the org row', async () => {
      const a = await org('a');
      const c = await org('c');
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM organisations WHERE id = $1 FOR UPDATE', [a]);
        const started = Date.now();
        expect(code(await store.move(a, { parentId: c }, permissiveTreeRules()))).toBe('ORG_BUSY');
        expect(Date.now() - started).toBeLessThan(2_000);
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
    });

    it('answers NOT_FOUND for an unknown org', async () => {
      expect(
        code(
          await store.move(
            '00000000-0000-0000-0000-000000000000',
            { parentId: rootId },
            permissiveTreeRules(),
          ),
        ),
      ).toBe('NOT_FOUND');
    });
  });

  describe('setKnownAs', () => {
    it("sets a key of the parent's list, the root's list for a top-level org", async () => {
      const a = await org('a');
      const b = await org('b', a);
      await seedList(rootId, [STATE]);
      await seedList(a, [BLOCK, TALUK]);
      const top = await store.setKnownAs(a, 'state', rootId, 'admin-1');
      expect(top.ok && [top.value.knownAs, top.value.knownAsName, top.value.updatedBy]).toEqual([
        'state',
        'State',
        'admin-1',
      ]);
      const child = await store.setKnownAs(b, 'taluk', a, 'owner-a');
      expect(child.ok && child.value.knownAsName).toBe('Taluk');
    });

    it('refuses KNOWN_AS_INVALID, ORG_MOVED, NOT_EDITABLE and NOT_FOUND', async () => {
      const a = await org('a');
      const b = await org('b', a);
      await seedList(a, [BLOCK]);
      expect(code(await store.setKnownAs(b, 'ward', a, 'x'))).toBe('KNOWN_AS_INVALID');
      expect(code(await store.setKnownAs(b, 'aggregator', a, 'x'))).toBe('KNOWN_AS_INVALID');
      expect(code(await store.setKnownAs(b, 'block', rootId, 'x'))).toBe('ORG_MOVED');
      expect(code(await store.setKnownAs(defaultId, 'aggregator', rootId, 'x'))).toBe(
        'NOT_EDITABLE',
      );
      expect(code(await store.setKnownAs(rootId, 'aggregator', rootId, 'x'))).toBe('NOT_FOUND');
      expect((await knownAsRow(b))[0]).toBe('aggregator');
    });

    it('refuses a rejected org with NOT_EDITABLE', async () => {
      const a = await org('a');
      const x = await org('x', a, 'inactive');
      await seedList(a, [BLOCK]);
      expect(code(await store.setKnownAs(x, 'block', a, 'x'))).toBe('NOT_EDITABLE');
      expect((await knownAsRow(x))[0]).toBe('aggregator');
    });

    it('allows only aggregator when the parent list is empty', async () => {
      const a = await org('a');
      const b = await org('b', a);
      expect(code(await store.setKnownAs(b, 'block', a, 'x'))).toBe('KNOWN_AS_INVALID');
      expect(code(await store.setKnownAs(b, 'aggregator', a, 'x'))).toBe('ok');
    });
  });

  describe('setKnownAsValues', () => {
    it('resets children whose key left the list, in every status, keeping updated_at', async () => {
      const a = await org('a');
      const b = await org('b', a);
      const p = await org('p', a, 'pending');
      const x = await org('x', a, 'inactive');
      const g = await org('g', a);
      await seedList(a, [BLOCK, TALUK]);
      await pool.query(`UPDATE organisations SET known_as = 'block' WHERE id IN ($1, $2, $3)`, [
        b,
        p,
        x,
      ]);
      const before = await Promise.all([b, p, x, g].map(knownAsRow));
      const r = await store.setKnownAsValues(
        a,
        [TALUK, { name: 'Ward', default: true }],
        'owner-a',
      );
      expect(r.ok && [r.value.resetCount, r.value.values]).toEqual([
        3,
        [TALUK, { ...WARD, default: true }],
      ]);
      expect(await listOf(a)).toEqual([TALUK, { ...WARD, default: true }]);
      const after = await Promise.all([b, p, x, g].map(knownAsRow));
      expect(after.map((row) => row[0])).toEqual(['ward', 'ward', 'ward', 'aggregator']);
      expect(after.map((row) => row[1])).toEqual(before.map((row) => row[1]));
    });

    it('resets to aggregator with no default, and a rename keeps the key', async () => {
      const a = await org('a');
      const b = await org('b', a);
      const c = await org('c', a);
      await seedList(a, [BLOCK, TALUK]);
      await store.setKnownAs(b, 'block', a, 'test');
      await store.setKnownAs(c, 'taluk', a, 'test');
      const r = await store.setKnownAsValues(a, [{ key: 'block', name: 'Mandal' }], 'test');
      expect(r.ok && r.value.resetCount).toBe(1);
      const rows = await Promise.all([b, c].map((id) => store.findById(id)));
      expect(rows.map((x) => x.ok && [x.value?.knownAs, x.value?.knownAsName])).toEqual([
        ['block', 'Mandal'],
        ['aggregator', 'Aggregator'],
      ]);
    });

    it('writes the root list; the Default org is never reset and reads as Aggregator', async () => {
      const a = await org('a');
      await pool.query(`UPDATE organisations SET known_as = 'gone' WHERE id IN ($1, $2)`, [
        a,
        defaultId,
      ]);
      const r = await store.setKnownAsValues(rootId, [{ name: 'State', default: true }], 'admin');
      expect(r.ok && [r.value.org.id, r.value.org.knownAsName, r.value.resetCount]).toEqual([
        rootId,
        null,
        1,
      ]);
      expect(await listOf(rootId)).toEqual([{ ...STATE, default: true }]);
      expect((await knownAsRow(a))[0]).toBe('state');
      expect((await knownAsRow(defaultId))[0]).toBe('gone');
      const def = await store.findDefault();
      expect(def.ok && def.value?.knownAsName).toBe('Aggregator');
    });

    it('gives a re-added name a new key and resets the children of the removed entry', async () => {
      const a = await org('a');
      const b = await org('b', a);
      await seedList(a, [STATE, BLOCK]);
      await pool.query(`UPDATE organisations SET known_as = 'state' WHERE id = $1`, [b]);
      const r = await store.setKnownAsValues(a, [BLOCK, { name: 'State' }], 'owner-a');
      expect(r.ok && [r.value.resetCount, r.value.values]).toEqual([
        1,
        [BLOCK, { key: 'state_2', name: 'State' }],
      ]);
      expect((await knownAsRow(b))[0]).toBe('aggregator');
    });

    it('refuses a sent key that is not in the list read under the lock', async () => {
      const a = await org('a');
      await seedList(a, [BLOCK]);
      const r = await store.setKnownAsValues(a, [{ name: 'New' }, TALUK], 'owner-a');
      expect(r.ok ? null : r.error).toMatchObject({ code: 'KNOWN_AS_UNKNOWN_KEY', index: 1 });
      expect(await listOf(a)).toEqual([BLOCK]);
    });

    it('stores the list as one row, in order, and stamps the writer', async () => {
      const a = await org('a');
      await seedList(a, [BLOCK, TALUK]);
      const seeded = await listRow(a);
      const r = await store.setKnownAsValues(
        a,
        [{ key: 'taluk', name: 'Tehsil', default: true }, BLOCK, { name: 'Ward' }],
        'owner-a',
      );
      expect(r.ok).toBe(true);
      const row = await listRow(a);
      expect(row?.known_as_values).toEqual([
        { key: 'taluk', name: 'Tehsil', default: true },
        BLOCK,
        { key: 'ward', name: 'Ward' },
      ]);
      expect(row?.created).toBe(seeded?.created);
      expect(row?.updated).not.toBe(seeded?.updated);
      expect(row?.updated_by).toBe('owner-a');
      const n = await pool.query('SELECT 1 FROM org_known_as WHERE org_id = $1', [a]);
      expect(n.rowCount).toBe(1);
    });

    it('does not write an unchanged list', async () => {
      const a = await org('a');
      await seedList(a, [BLOCK, { ...TALUK, default: true }]);
      const seeded = await listRow(a);
      const r = await store.setKnownAsValues(a, [BLOCK, { ...TALUK, default: true }], 'owner-a');
      expect(r.ok && r.value.values).toEqual([BLOCK, { ...TALUK, default: true }]);
      expect(await listRow(a)).toEqual(seeded);
    });

    it('creates the row for a first list and deletes it for an empty list', async () => {
      const a = await org('a');
      expect(await listRow(a)).toBeUndefined();
      expect(code(await store.setKnownAsValues(a, [{ name: 'Block' }], 'owner-a'))).toBe('ok');
      expect((await listRow(a))?.known_as_values).toEqual([BLOCK]);
      expect(code(await store.setKnownAsValues(a, [], 'owner-a'))).toBe('ok');
      expect(await listRow(a)).toBeUndefined();
      expect(await listOf(a)).toEqual([]);
    });

    it('swaps names and moves the default in one save without a unique violation', async () => {
      const a = await org('a');
      await seedList(a, [{ ...BLOCK, default: true }, TALUK]);
      const r = await store.setKnownAsValues(
        a,
        [
          { key: 'block', name: 'Taluk' },
          { key: 'taluk', name: 'Block', default: true },
        ],
        'owner-a',
      );
      expect(code(r)).toBe('ok');
      expect(await listOf(a)).toEqual([
        { key: 'block', name: 'Taluk' },
        { key: 'taluk', name: 'Block', default: true },
      ]);
    });

    it('refuses the Default org with NOT_EDITABLE and an unknown org with NOT_FOUND', async () => {
      expect(code(await store.setKnownAsValues(defaultId, [BLOCK], 'x'))).toBe('NOT_EDITABLE');
      expect(
        code(await store.setKnownAsValues('00000000-0000-0000-0000-000000000000', [BLOCK], 'x')),
      ).toBe('NOT_FOUND');
    });
  });

  describe('known_as reads', () => {
    it('resolves known_as_name from the parent row, Aggregator for a key it lacks', async () => {
      const a = await org('a');
      const b = await org('b', a);
      const c = await org('c', a);
      const d = await org('d', a);
      const e = await org('e');
      await seedList(a, [BLOCK, { ...TALUK, default: true }]);
      await pool.query(`UPDATE organisations SET known_as = 'block' WHERE id = $1`, [b]);
      await pool.query(`UPDATE organisations SET known_as = 'gone' WHERE id = $1`, [c]);
      await pool.query(`UPDATE organisations SET known_as = 'taluk' WHERE id = $1`, [d]);
      // The root has no row: its children read as Aggregator.
      await pool.query(`UPDATE organisations SET known_as = 'state' WHERE id = $1`, [e]);
      const rows = await Promise.all([b, c, d, e].map((id) => store.findById(id)));
      expect(rows.map((x) => x.ok && x.value?.knownAsName)).toEqual([
        'Block',
        'Aggregator',
        'Taluk',
        'Aggregator',
      ]);
    });

    it('names the default value of each org that has one', async () => {
      const a = await org('a');
      const c = await org('c');
      await seedList(rootId, [{ ...STATE, default: true }]);
      await seedList(a, [BLOCK, { ...TALUK, default: true }]);
      await seedList(c, [WARD]);
      const r = await store.defaultKnownAsNames([rootId, a, c]);
      expect(r.ok && r.value).toEqual({ [rootId]: 'State', [a]: 'Taluk' });
    });

    it('counts live orgs whose key is neither aggregator nor a key of the parent', async () => {
      const a = await org('a');
      const b = await org('b', a);
      const p = await org('p', a, 'pending');
      const x = await org('x', a, 'inactive');
      await seedList(a, [BLOCK]);
      await pool.query(`UPDATE organisations SET known_as = 'block' WHERE id = $1`, [b]);
      await pool.query(`UPDATE organisations SET known_as = 'gone' WHERE id IN ($1, $2, $3)`, [
        p,
        x,
        defaultId,
      ]);
      const r = await store.countStaleKnownAs();
      expect(r.ok && r.value).toBe(1);
    });

    it('drops the values of a deleted org', async () => {
      const p = await org('p', undefined, 'pending');
      await seedList(p, [BLOCK]);
      await store.deleteById(p);
      expect(await listOf(p)).toEqual([]);
    });
  });

  describe('concurrent tree writes', () => {
    /**
     * Holds a SHARE lock on `organisations` while `run` starts its writes, so
     * every write that is not serialised by the tree lock reads the tree
     * before any of them can change it.
     */
    async function withWritesHeld<T>(run: () => Promise<T>): Promise<T> {
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('LOCK TABLE organisations IN SHARE MODE');
        const pending = run();
        await sleep(300);
        await holder.query('COMMIT');
        return await pending;
      } finally {
        holder.release();
      }
    }

    it('lets only one of two crossing moves through, so no cycle forms', async () => {
      const a = await org('a');
      const b = await org('b');
      const results = await withWritesHeld(() =>
        Promise.all([
          store.move(a, { parentId: b }, permissiveTreeRules()),
          store.move(b, { parentId: a }, permissiveTreeRules()),
        ]),
      );
      expect(results.map(code).sort()).toEqual(['PARENT_CYCLE', 'ok']);
    });

    it('keeps a valid key when a known_as change races a move', async () => {
      const a = await org('a');
      const c = await org('c');
      await seedList(rootId, [STATE]);
      const [moved, named] = await withWritesHeld(async () => {
        const m = store.move(a, { parentId: c }, permissiveTreeRules());
        await sleep(100);
        const n = store.setKnownAs(a, 'state', rootId, 'test');
        return Promise.all([m, n]);
      });
      expect(code(moved)).toBe('ok');
      expect(['ok', 'ORG_MOVED']).toContain(code(named));
      const row = await store.findById(a);
      if (!row.ok || !row.value) throw new Error('org missing');
      expect(row.value.parentId).toBe(c);
      expect(knownAsKeyValid([], row.value.knownAs)).toBe(true);
    });

    it('keeps a valid key when a known_as change races a list edit', async () => {
      const a = await org('a');
      const b = await org('b', a);
      await seedList(a, [BLOCK]);
      await withWritesHeld(async () => {
        const edit = store.setKnownAsValues(a, [{ name: 'Taluk' }], 'test');
        await sleep(100);
        const named = store.setKnownAs(b, 'block', a, 'test');
        return Promise.all([edit, named]);
      });
      expect(knownAsKeyValid([TALUK], (await knownAsRow(b))[0])).toBe(true);
    });
  });

  describe('parentOptions', () => {
    it('lists the root and every other org with the result a move would give', async () => {
      const a = await org('a');
      const b = await org('b', a);
      const c = await org('c');
      const p = await org('p', undefined, 'pending');
      const full = await org('full');
      const f1 = await org('f1', full);
      const r = await store.parentOptions(b, permissiveTreeRules({ maxDepth: 2, maxChildren: 1 }));
      if (!r.ok) throw new Error(r.error.code);
      expect(r.value.subtreeSize).toBe(1);
      const reasons = Object.fromEntries(
        r.value.options.map((o) => [o.org.id, o.ok ? 'ok' : o.reason]),
      );
      expect(reasons).toEqual({
        [a]: 'ok',
        [c]: 'ok',
        [p]: 'INVALID_PARENT',
        [full]: 'CHILD_LIMIT',
        [f1]: 'DEPTH_LIMIT',
        [defaultId]: 'INVALID_PARENT',
        [rootId]: 'CHILD_LIMIT',
      });
      expect(r.value.options.some((o) => o.org.id === b)).toBe(false);
    });
  });

  describe('counts and descendants', () => {
    it('childCounts and countTotal count pending and active orgs, Default excluded', async () => {
      const c = await org('c');
      await org('p', c, 'pending');
      await org('x', c, 'inactive');
      const r = await store.childCounts([rootId, c, defaultId]);
      expect(r).toEqual({ ok: true, value: { [rootId]: 1, [c]: 1, [defaultId]: 0 } });
      expect(await store.countTotal()).toEqual({ ok: true, value: 2 });
    });

    it('descendantIds stops 32 levels down', async () => {
      let parent = await org('n0');
      const top = parent;
      for (let i = 1; i <= 34; i++) parent = await org(`n${i}`, parent);
      const r = await store.descendantIds([top]);
      expect(r.ok && r.value.length).toBe(32);
    });
  });
});
