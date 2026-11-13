/**
 * Real-Postgres integration tests for migration 0027 (`users`) and the code
 * written against it (`@aggregator-dpg/api`). Runs only with
 * `INTEGRATION_DATABASE_URL` set (the `db-integration` CI job); excluded from
 * `pnpm -w test`.
 *
 * Covers what a fake cannot: the role-shape CHECK against the column
 * defaults, the owner-release trigger on any org delete, contact GC, the slug
 * lock after the rename, identity uniqueness, the coordinator-only store
 * filter, and org create / owner identity through the real stores.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { getDb, getPool, closeDb, _setDbClients } from '../client.js';
import { PostgresUserStore } from '../../services/user-store/postgres.js';
import { PostgresOrganisationStore } from '../../services/organisation-store/postgres.js';
import { permissiveTreeRules } from '../../services/organisation-store/testing.js';
import { PostgresIdentityStore } from '../../services/identity-store/postgres.js';
import { NO_CONSENT_WRITE } from '../../services/consent-ledger/hook.js';

const realUrl = process.env.INTEGRATION_DATABASE_URL;
const suite = realUrl ? describe : describe.skip;

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../drizzle/migrations',
);
const CONSENT = {
  value: true,
  given_at: '2026-01-01T00:00:00.000Z',
  valid_till: '2027-01-01T00:00:00.000Z',
};

function phone(): string {
  return `+91${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`;
}
function email(): string {
  return `it-${randomUUID().slice(0, 8)}@example.org`;
}

suite('users (migration 0027) — integration', () => {
  let pool: pg.Pool;
  const aggStore = new PostgresUserStore();
  const orgStore = new PostgresOrganisationStore();
  const identities = new PostgresIdentityStore();
  /** The Default org (0028): every coordinator needs an org. */
  let defaultOrgId = '';

  beforeAll(async () => {
    _setDbClients(null, null);
    getPool({ url: realUrl! });
    await migrate(getDb(), { migrationsFolder: MIGRATIONS_DIR });
    pool = new pg.Pool({ connectionString: realUrl, max: 4 });
    const d = await pool.query(`SELECT id FROM organisations WHERE slug = 'default'`);
    defaultOrgId = d.rows[0].id;
  });

  afterAll(async () => {
    await pool?.end();
    await closeDb();
  });

  async function newCoordinator(e = email(), p = phone()) {
    const r = await aggStore.create({
      recordConsent: NO_CONSENT_WRITE,
      orgSlug: `it-${randomUUID().slice(0, 8)}`,
      name: 'IT Coordinator',
      type: null,
      contact: { name: 'Coord', email: e, phone: p },
      consent: CONSENT,
      createdBy: 'it',
      orgId: defaultOrgId,
      updatedBy: 'it',
    });
    if (!r.ok) throw new Error(`coordinator create failed: ${r.error.code}`);
    return r.value;
  }

  async function newOrg(ownerEmail = email(), ownerPhone = phone()) {
    const r = await orgStore.create(
      {
        recordConsent: NO_CONSENT_WRITE,
        slug: `it-org-${randomUUID().slice(0, 8)}`,
        displayName: `IT Org ${randomUUID().slice(0, 8)}`,
        ownerEmail,
        ownerPhone,
        ownerName: 'Owner',
      },
      permissiveTreeRules(),
    );
    if (!r.ok) throw new Error(`org create failed: ${r.error.code}`);
    return r.value;
  }

  const count = async (q: string, params: unknown[] = []): Promise<number> =>
    Number((await pool.query(q, params)).rows[0].n);

  it('creates an org with an identity-only admin owner (explicit NULLs satisfy the role CHECK)', async () => {
    const org = await newOrg();
    const admin = await pool.query(
      `SELECT user_type, status, org_id, legacy_org_details, profile, serves, alternate_phone,
              invite_id, signalstack_org_slug
         FROM users WHERE id = $1`,
      [org.ownerUserId],
    );
    expect(admin.rows[0]).toEqual({
      user_type: 'admin',
      status: null,
      org_id: null,
      legacy_org_details: null,
      profile: null,
      serves: [],
      alternate_phone: null,
      invite_id: null,
      signalstack_org_slug: null,
    });
    await orgStore.deleteById(org.id);
  });

  it('rejects an admin row that inherits the coordinator defaults (role CHECK)', async () => {
    const c = await newCoordinator();
    await expect(
      pool.query(
        `INSERT INTO users (user_type, contact_id, created_by, updated_by)
         VALUES ('admin', $1, 'it', 'it')`,
        [c.contactId],
      ),
    ).rejects.toThrow(/users_role_shape_chk/);
    await aggStore.deleteById(c.id);
  });

  it('reuses one admin account for an owner of two orgs; releases it only with the last org', async () => {
    const e = email();
    const p = phone();
    const a = await newOrg(e, p);
    const b = await newOrg(e, p);
    expect(a.ownerUserId).toBe(b.ownerUserId);
    expect(await orgStore.ownerIsShared(a.id)).toEqual({ ok: true, value: true });

    // Raw delete (not the store): the database itself releases the owner.
    await pool.query('DELETE FROM organisations WHERE id = $1', [a.id]);
    expect(await count('SELECT count(*) AS n FROM users WHERE id = $1', [a.ownerUserId])).toBe(1);

    await pool.query('DELETE FROM organisations WHERE id = $1', [b.id]);
    expect(await count('SELECT count(*) AS n FROM users WHERE id = $1', [a.ownerUserId])).toBe(0);
    // …and the contact is collected, so the email/phone are free again.
    expect(await count('SELECT count(*) AS n FROM contact WHERE email = $1', [e])).toBe(0);
    const again = await newOrg(e, p);
    await orgStore.deleteById(again.id);
  });

  it('keeps a person who is an owner AND a coordinator: one contact, two accounts', async () => {
    const e = email();
    const p = phone();
    const coord = await newCoordinator(e, p);
    const org = await newOrg(e, p);
    expect(org.contactId).toBe(coord.contactId);
    // Deleting the org releases the admin account but keeps the shared contact.
    await orgStore.deleteById(org.id);
    expect(await count('SELECT count(*) AS n FROM contact WHERE email = $1', [e])).toBe(1);
    await aggStore.deleteById(coord.id);
    expect(await count('SELECT count(*) AS n FROM contact WHERE email = $1', [e])).toBe(0);
  });

  it('never resolves an admin account through the aggregator store (read or write)', async () => {
    const org = await newOrg();
    const read = await aggStore.findById(org.ownerUserId);
    expect(read).toEqual({ ok: true, value: null });
    const write = await aggStore.updateSignalstackOrgId(org.ownerUserId, 'x', 'it');
    expect(write.ok || write.error.code).toBe('NOT_FOUND');
    const del = await aggStore.deleteById(org.ownerUserId);
    expect(del.ok || del.error.code).toBe('NOT_FOUND');
    expect(await count('SELECT count(*) AS n FROM users WHERE id = $1', [org.ownerUserId])).toBe(1);
    await orgStore.deleteById(org.id);
  });

  it('stamps the owner login as an identity and reads it back as ownerKcSub', async () => {
    const org = await newOrg();
    const sub = randomUUID();
    const stamped = await orgStore.update(org.id, { ownerKcSub: sub, kcGroupId: 'g-1' });
    expect(stamped.ok && stamped.value.ownerKcSub).toBe(sub);
    expect(stamped.ok && stamped.value.kcGroupId).toBe('g-1');
    // A different subject for the same owner is never overwritten.
    const other = await orgStore.update(org.id, { ownerKcSub: randomUUID() });
    expect(other.ok).toBe(false);
    const after = await orgStore.findById(org.id);
    expect(after.ok && after.value?.ownerKcSub).toBe(sub);
    await orgStore.deleteById(org.id);
  });

  it('enforces one account per external login (provider, subject)', async () => {
    const c1 = await newCoordinator();
    const c2 = await newCoordinator();
    const sub = randomUUID();
    expect(await identities.link(c1.id, 'keycloak', sub)).toEqual({ ok: true, value: 'linked' });
    expect(await identities.link(c1.id, 'keycloak', sub)).toEqual({ ok: true, value: 'already' });
    const dup = await identities.link(c2.id, 'keycloak', sub);
    expect(dup.ok || dup.error.code).toBe('DUPLICATE');
    expect(await identities.userOf('keycloak', sub)).toEqual({ ok: true, value: c1.id });
    await aggStore.deleteById(c1.id);
    // The identity cascades with its account.
    expect(await identities.userOf('keycloak', sub)).toEqual({ ok: true, value: null });
    await aggStore.deleteById(c2.id);
  });

  it('treats an owner as shared when they own another org or are also a coordinator', async () => {
    const solo = await newOrg();
    expect(await orgStore.ownerIsShared(solo.id)).toEqual({ ok: true, value: false });
    const e = email();
    const p = phone();
    const coord = await newCoordinator(e, p);
    const both = await newOrg(e, p);
    // One IdP user per person: pruning this org must not delete the
    // coordinator's login.
    expect(await orgStore.ownerIsShared(both.id)).toEqual({ ok: true, value: true });
    await orgStore.deleteById(both.id);
    await aggStore.deleteById(coord.id);
    await orgStore.deleteById(solo.id);
  });

  it('never links a login to an admin account through the coordinator path', async () => {
    const org = await newOrg();
    const r = await identities.link(org.ownerUserId, 'keycloak', randomUUID(), 'coordinator');
    expect(r.ok || r.error.code).toBe('NOT_LINKABLE');
    const missing = await identities.link(randomUUID(), 'keycloak', randomUUID(), 'coordinator');
    expect(missing.ok || missing.error.code).toBe('NOT_LINKABLE');
    await orgStore.deleteById(org.id);
  });

  it('keeps the Signals org slug immutable under its new name; other updates work', async () => {
    const c = await newCoordinator();
    await expect(
      pool.query(`UPDATE users SET signalstack_org_slug = 'changed' WHERE id = $1`, [c.id]),
    ).rejects.toThrow(/signalstack_org_slug is immutable/);
    const renamed = await aggStore.update(c.id, { name: 'Renamed', updatedBy: 'it' });
    expect(renamed.ok && renamed.value.name).toBe('Renamed');
    await aggStore.deleteById(c.id);
  });
});
