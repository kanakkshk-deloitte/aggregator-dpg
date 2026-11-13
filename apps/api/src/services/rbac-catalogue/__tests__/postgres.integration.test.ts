/**
 * Real-Postgres integration tests for migrations 0030/0031 (`permission`,
 * `role`, `role_permission`, `user_role`, `iam_audit` and the built-in seed)
 * and the Postgres catalogue store (`@aggregator-dpg/api`). Runs only with
 * `INTEGRATION_DATABASE_URL` set (the `db-integration` CI job).
 *
 * The drift tests are the build-time guard that replaced the old runtime
 * checksum: against the migrated database they assert the seeded `permission`
 * rows equal `permissionDefinitions(CAPABILITIES)` and the seeded built-in
 * roles equal `BUILTIN_ROLES` and pass `roleCatalogueIssues`. The rest covers
 * what a fake cannot: the revision changing with every role edit, the table
 * constraints, and the custom-role lifecycle.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import {
  BUILTIN_ROLES,
  CAPABILITIES,
  permissionDefinitions,
  roleCatalogueIssues,
} from '@aggregator-dpg/rbac';
import { buildRole } from '@aggregator-dpg/rbac/testing';
import { getDb, getPool, closeDb, _setDbClients } from '../../../db/client.js';
import { PostgresRbacCatalogue } from '../postgres.js';

const realUrl = process.env.INTEGRATION_DATABASE_URL;
const suite = realUrl ? describe : describe.skip;

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(here, '../../../../drizzle/migrations');
const PERMS = permissionDefinitions(CAPABILITIES);
const byKey = <T extends { key: string }>(rs: readonly T[]): T[] =>
  [...rs].sort((a, b) => a.key.localeCompare(b.key));

suite('rbac catalogue (migrations 0030/0031) — integration', () => {
  let pool: pg.Pool;
  const builtins = byKey(BUILTIN_ROLES);
  const store = new PostgresRbacCatalogue();

  async function revision(): Promise<string> {
    const r = await store.revision();
    return r.ok ? r.value : 'FAILED';
  }
  async function roleKeys(): Promise<string[]> {
    const l = await store.load();
    return l.ok ? l.value.roles.map((r) => r.key).sort() : [];
  }

  beforeAll(async () => {
    _setDbClients(null, null);
    getPool({ url: realUrl! });
    await migrate(getDb(), { migrationsFolder: MIGRATIONS_DIR });
    pool = new pg.Pool({ connectionString: realUrl, max: 4 });
  });

  afterAll(async () => {
    await pool?.end();
    await closeDb();
  });

  it('creates the RBAC tables', async () => {
    const t = await pool.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_name IN ('permission','role','role_permission','user_role','iam_audit') ORDER BY 1`,
    );
    expect(t.rows.map((r) => r.table_name)).toEqual([
      'iam_audit',
      'permission',
      'role',
      'role_permission',
      'user_role',
    ]);
  });

  it('seeds the permission catalogue equal to the code (drift guard)', async () => {
    const p = await pool.query(
      `SELECT key, resource, action, description, sensitive
         FROM permission WHERE NOT deprecated ORDER BY key`,
    );
    expect(p.rows).toEqual(byKey(PERMS));
    const pii = await pool.query(`SELECT * FROM permission WHERE key = 'profiles.view_pii'`);
    expect(pii.rows[0]).toMatchObject({
      resource: 'profiles',
      action: 'view_pii',
      sensitive: true,
      deprecated: false,
    });
  });

  it('seeds exactly the built-in roles of BUILTIN_ROLES', async () => {
    const loaded = await store.load();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.revision).toMatch(/^[0-9a-f]{32}$/);
    const seeded = byKey(loaded.value.roles.filter((r) => r.isBuiltin));
    expect(seeded).toEqual(
      builtins.map((r) => ({ ...r, permissions: [...r.permissions].sort() })),
    );
  });

  it('seeds built-in roles that pass the catalogue rules and reference known permissions', async () => {
    const loaded = await store.load();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const seeded = loaded.value.roles.filter((r) => r.isBuiltin);
    expect(roleCatalogueIssues(seeded)).toEqual([]);
    const known = new Set<string>(CAPABILITIES);
    for (const r of seeded) {
      for (const permissionKey of r.permissions) expect(known.has(permissionKey)).toBe(true);
    }
  });

  it('changes the revision on a role edit and back on its reversal', async () => {
    const before = await revision();
    await pool.query(`INSERT INTO role_permission VALUES ('coordinator', 'profiles.export')`);
    expect(await revision()).not.toBe(before);
    await pool.query(
      `DELETE FROM role_permission WHERE role_key = 'coordinator' AND permission_key = 'profiles.export'`,
    );
    expect(await revision()).toBe(before);
  });

  it('enforces the role constraints', async () => {
    await expect(
      pool.query(
        `INSERT INTO role (key, name, account_type, base_for, assignable_org_types, is_builtin)
         VALUES ('c2', 'C2', 'coordinator', 'org_member', '{aggregator}', true)`,
      ),
    ).rejects.toThrow(/role_base_for_unique/);
    await expect(
      pool.query(
        `INSERT INTO role (key, name, account_type, assignable_org_types) VALUES ('x', 'X', 'coordinator', '{aggregator}')`,
      ),
    ).rejects.toThrow(/role_additional_shape_chk/);
    await expect(
      pool.query(
        `INSERT INTO role (key, name, account_type, assignable_org_types, assigned_by) VALUES ('Bad Key', 'X', 'coordinator', '{aggregator}', 'org.manage')`,
      ),
    ).rejects.toThrow(/role_key_chk/);
    await expect(
      pool.query(`INSERT INTO role_permission VALUES ('gone', 'profiles.teleport')`),
    ).rejects.toThrow(/foreign key/);
    await expect(pool.query(`DELETE FROM permission WHERE key = 'profiles.view'`)).rejects.toThrow(
      /foreign key/,
    );
  });

  it('creates, changes and deletes a custom role, refusing while it is assigned', async () => {
    // The migrations seed the root's placeholder owner: an admin account.
    const admin: string = (
      await pool.query(`SELECT id FROM users WHERE user_type = 'admin' LIMIT 1`)
    ).rows[0]?.id;
    expect(admin).toBeTruthy();
    const def = (await pool.query(`SELECT id FROM organisations WHERE slug = 'default'`)).rows[0]
      .id;
    const role = buildRole({ key: 'auditor', permissions: ['profiles.view'] });

    expect(await store.createRole(role, admin)).toEqual({ ok: true, value: { created: true } });
    expect(await store.createRole(role, admin)).toEqual({ ok: true, value: { created: false } });
    expect(await roleKeys()).toContain('auditor');
    const changed = await store.updateRole(
      { ...role, permissions: ['profiles.verify', 'profiles.view'] },
      admin,
    );
    expect(changed).toEqual({ ok: true, value: { updated: true } });
    const loaded = await store.load();
    expect(loaded.ok && loaded.value.roles.find((r) => r.key === 'auditor')?.permissions).toEqual([
      'profiles.verify',
      'profiles.view',
    ]);
    expect(await store.updateRole({ ...builtins[0]!, isBuiltin: false }, admin)).toEqual({
      ok: true,
      value: { updated: false },
    });

    await pool.query(
      `INSERT INTO user_role (user_id, role_key, org_id) VALUES ($1, 'auditor', $2)`,
      [admin, def],
    );
    expect(await store.deleteRole('auditor', admin)).toEqual({ ok: true, value: 'in_use' });
    await pool.query(`UPDATE user_role SET revoked_at = now() WHERE role_key = 'auditor'`);
    expect(await store.deleteRole('auditor', admin)).toEqual({ ok: true, value: 'deleted' });
    expect(
      (await pool.query(`SELECT count(*)::int n FROM user_role WHERE role_key = 'auditor'`)).rows[0]
        .n,
    ).toBe(0);
    expect(await store.deleteRole('coordinator', admin)).toEqual({ ok: true, value: 'not_found' });
    const events = await pool.query(
      `SELECT event FROM iam_audit WHERE event LIKE 'catalogue.role.%' ORDER BY at`,
    );
    expect(events.rows.map((r) => r.event)).toEqual([
      'catalogue.role.create',
      'catalogue.role.update',
      'catalogue.role.delete',
    ]);
  });
});
