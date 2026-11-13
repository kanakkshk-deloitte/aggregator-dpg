/**
 * Real-Postgres integration tests for the consent write inside the create
 * transaction (migration 0029, `@aggregator-dpg/api`): what the store stubs
 * cannot show — the ledger row committing with the coordinator or org, a
 * ledger failure rolling the account, its contact and the consent back
 * together, the profile's `consent` read back from the ledger, the invited
 * address read through `invite_id` (or the pre-0029 `legacy_invite_email`),
 * and the alternate phone round trip.
 *
 * Runs only with `INTEGRATION_DATABASE_URL` set (the `db-integration` CI
 * job); excluded from `pnpm -w test`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { PostgresConsentLedger } from '@aggregator-dpg/consent-ledger/postgres';
import { getDb, getPool, closeDb, _setDbClients } from '../client.js';
import { PostgresUserStore } from '../../services/user-store/postgres.js';
import { PostgresOrganisationStore } from '../../services/organisation-store/postgres.js';
import { permissiveTreeRules } from '../../services/organisation-store/testing.js';
import type { RecordConsentHook } from '../../services/consent-ledger/hook.js';

const realUrl = process.env.INTEGRATION_DATABASE_URL;
const suite = realUrl ? describe : describe.skip;

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../drizzle/migrations',
);
const VALID_TILL = '2027-06-01T00:00:00.000Z';
const CONSENT = {
  value: true as const,
  given_at: '2026-06-01T00:00:00.000Z',
  valid_till: VALID_TILL,
};

function phone(): string {
  return `+91${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`;
}
function email(): string {
  return `ct-${randomUUID().slice(0, 8)}@example.org`;
}

suite('consent in the create transaction (migration 0029) — integration', () => {
  let pool: pg.Pool;
  const aggStore = new PostgresUserStore();
  const orgStore = new PostgresOrganisationStore();
  let ledger: PostgresConsentLedger;
  let defaultOrgId = '';

  /** The routes' hook: a ledger row through the store's transaction; `err` throws. */
  const writes =
    (subjectType: 'user' | 'organisation'): RecordConsentHook =>
    async (tx, id) => {
      const r = await ledger.withExecutor(tx).recordRegistrationConsent({
        subjectType,
        subjectId: id,
        network: 'blue_dot',
        brand: null,
        termsVersion: 1,
        privacyVersion: 1,
        validTill: new Date(VALID_TILL),
      });
      if (!r.success) throw r.error;
    };
  const fails: RecordConsentHook = async () => {
    throw new Error('ledger down');
  };

  const count = async (q: string, params: unknown[] = []): Promise<number> =>
    Number((await pool.query(q, params)).rows[0].n);

  beforeAll(async () => {
    _setDbClients(null, null);
    getPool({ url: realUrl! });
    await migrate(getDb(), { migrationsFolder: MIGRATIONS_DIR });
    ledger = new PostgresConsentLedger(getDb());
    pool = new pg.Pool({ connectionString: realUrl, max: 4 });
    defaultOrgId = (await pool.query(`SELECT id FROM organisations WHERE slug = 'default'`)).rows[0]
      .id;
  });

  afterAll(async () => {
    await pool?.end();
    await closeDb();
  });

  function coordinatorInput(e: string, recordConsent: RecordConsentHook, extra = {}) {
    return {
      orgSlug: `ct-${randomUUID().slice(0, 8)}`,
      name: 'CT Coordinator',
      type: 'seeker',
      contact: { name: 'Coord', email: e, phone: phone() },
      consent: CONSENT,
      recordConsent,
      createdBy: 'it',
      updatedBy: 'it',
      orgId: defaultOrgId,
      ...extra,
    };
  }

  it('commits the consent row with the coordinator and reads consent back from it', async () => {
    const r = await aggStore.create(coordinatorInput(email(), writes('user')));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = await pool.query(
      `SELECT user_id, subject_type, source, valid_till, accepted_at FROM consent_record WHERE subject_id = $1`,
      [r.value.id],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]).toMatchObject({
      user_id: r.value.id,
      subject_type: 'user',
      source: 'registration',
    });
    // The profile's consent is the ledger row (given_at = accepted_at, G14).
    expect(r.value.consent).toEqual({
      value: true,
      given_at: (row.rows[0].accepted_at as Date).toISOString(),
      valid_till: VALID_TILL,
    });
    expect(r.value.serves).toEqual(['seeker']);
  });

  it('rolls the coordinator, its contact and the consent back together when the ledger fails', async () => {
    const e = email();
    const r = await aggStore.create(coordinatorInput(e, fails));
    expect(r).toEqual({
      ok: false,
      error: { code: 'CONSENT_WRITE_FAILED', message: 'consent could not be recorded' },
    });
    expect(await count(`SELECT count(*) AS n FROM contact WHERE email = $1`, [e])).toBe(0);
    expect(
      await count(
        `SELECT count(*) AS n FROM users u JOIN contact c ON c.id = u.contact_id WHERE c.email = $1`,
        [e],
      ),
    ).toBe(0);
  });

  it('rolls back when the ledger refuses the row (a validation err, not a driver error)', async () => {
    const e = email();
    const bad: RecordConsentHook = async (tx, id) => {
      const r = await ledger.withExecutor(tx).recordRegistrationConsent({
        subjectType: 'user',
        subjectId: id,
        network: '',
        termsVersion: 1,
        privacyVersion: 1,
      });
      if (!r.success) throw r.error;
    };
    const r = await aggStore.create(coordinatorInput(e, bad));
    expect(r.ok).toBe(false);
    expect(await count(`SELECT count(*) AS n FROM contact WHERE email = $1`, [e])).toBe(0);
  });

  it('reads the invited address through invite_id, else the legacy address on the row', async () => {
    const jti = randomUUID();
    await pool.query(
      `INSERT INTO registration_invites (jti, org_id, email, status, expires_at, created_by, consumed_at)
       VALUES ($1, $2, 'invited@example.org', 'consumed', now() + interval '1 day', 'it', now())`,
      [jti, defaultOrgId],
    );
    const viaInvite = await aggStore.create(
      coordinatorInput(email(), writes('user'), { inviteId: jti }),
    );
    expect(viaInvite.ok && viaInvite.value.inviteEmail).toBe('invited@example.org');
    expect(viaInvite.ok && viaInvite.value.inviteId).toBe(jti);

    const legacy = await aggStore.create(
      coordinatorInput(email(), writes('user'), {
        profile: { legacy_invite_email: 'old@example.org' },
      }),
    );
    expect(legacy.ok && legacy.value.inviteEmail).toBe('old@example.org');
    expect(legacy.ok && legacy.value.inviteId).toBeNull();
  });

  it('round-trips the alternate phone and drops the key when cleared', async () => {
    const e = email();
    const created = await aggStore.create(
      coordinatorInput(e, writes('user'), {
        contact: { name: 'Coord', email: e, phone: phone(), alternatePhone: '+919811122233' },
      }),
    );
    if (!created.ok) throw new Error('create');
    expect(created.value.contact.alternatePhone).toBe('+919811122233');
    const cleared = await aggStore.update(created.value.id, {
      contact: { name: 'Coord', email: e, phone: created.value.contactPhone },
      updatedBy: 'it',
    });
    expect(cleared.ok && 'alternatePhone' in cleared.value.contact).toBe(false);
  });

  it('commits the org consent row with the org, and rolls the org, owner and contact back on failure', async () => {
    const ok = await orgStore.create(
      {
        slug: `ct-org-${randomUUID().slice(0, 8)}`,
        displayName: `CT Org ${randomUUID().slice(0, 8)}`,
        ownerEmail: email(),
        ownerPhone: phone(),
        recordConsent: writes('organisation'),
      },
      permissiveTreeRules(),
    );
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    const row = await pool.query(
      `SELECT org_id, user_id, subject_type, valid_till FROM consent_record WHERE subject_id = $1`,
      [ok.value.id],
    );
    expect(row.rows[0]).toMatchObject({
      org_id: ok.value.id,
      user_id: null,
      subject_type: 'organisation',
    });
    expect((row.rows[0].valid_till as Date).toISOString()).toBe(VALID_TILL);

    const ownerEmail = email();
    const slug = `ct-org-${randomUUID().slice(0, 8)}`;
    const failed = await orgStore.create(
      {
        slug,
        displayName: `CT Org ${randomUUID().slice(0, 8)}`,
        ownerEmail,
        ownerPhone: phone(),
        recordConsent: fails,
      },
      permissiveTreeRules(),
    );
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.code).toBe('CONSENT_WRITE_FAILED');
    expect(await count(`SELECT count(*) AS n FROM organisations WHERE slug = $1`, [slug])).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM contact WHERE email = $1`, [ownerEmail])).toBe(0);
  });

  it("keeps a deleted coordinator's consent, unlinked (P4-3)", async () => {
    const r = await aggStore.create(coordinatorInput(email(), writes('user')));
    if (!r.ok) throw new Error('create');
    expect((await aggStore.deleteById(r.value.id)).ok).toBe(true);
    const row = await pool.query(`SELECT user_id FROM consent_record WHERE subject_id = $1`, [
      r.value.id,
    ]);
    expect(row.rows).toEqual([{ user_id: null }]);
  });
});
