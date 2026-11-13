/**
 * Unit tests for the registration-invites store (#700).
 *
 * In-memory tests exercise the behavioural contract (partial-unique pending,
 * CAS consume/revoke, refresh-only-when-pending). A small Postgres block covers
 * the driver-error mapping the in-memory impl can't reach (DUPLICATE_PENDING
 * from a wrapped SQLSTATE 23505, and the DB_UNAVAILABLE fallback).
 *
 * @module @aggregator-dpg/api
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  InMemoryRegistrationInvitesStore,
  RegistrationInvitesStoreFake,
  buildRegistrationInvite,
  PostgresRegistrationInvitesStore,
} from '../index.js';
import { _setDbClients } from '../../../db/client.js';

const ORG = '00000000-0000-0000-0000-0000000000aa';

describe('InMemoryRegistrationInvitesStore', () => {
  const input = {
    parentOrgId: ORG,
    email: 'a@x.org',
    expiresAt: new Date('2027-01-01'),
    createdBy: 'owner',
  };

  it('creates a pending invite and finds it by jti', async () => {
    const s = new InMemoryRegistrationInvitesStore();
    const created = await s.create(input);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.status).toBe('pending');
    expect(created.value.role).toBe('coordinator');
    const found = await s.findByJti(created.value.jti);
    expect(found.ok && found.value?.email).toBe('a@x.org');
  });

  it('rejects a second live invite for the same (org, email) with DUPLICATE_PENDING', async () => {
    const s = new InMemoryRegistrationInvitesStore();
    await s.create(input);
    const dup = await s.create(input);
    expect(dup.ok).toBe(false);
    if (dup.ok) return;
    expect(dup.error.code).toBe('DUPLICATE_PENDING');
  });

  it('allows a new invite once the prior one is consumed (partial-unique is pending-only)', async () => {
    const s = new InMemoryRegistrationInvitesStore();
    const first = await s.create(input);
    if (!first.ok) throw new Error('seed');
    await s.consume(first.value.jti);
    const second = await s.create(input);
    expect(second.ok).toBe(true);
  });

  it('findPendingByOrgAndEmail returns only pending rows', async () => {
    const s = new InMemoryRegistrationInvitesStore();
    const c = await s.create(input);
    if (!c.ok) throw new Error('seed');
    let hit = await s.findPendingByOrgAndEmail(ORG, 'a@x.org');
    expect(hit.ok && hit.value?.jti).toBe(c.value.jti);
    await s.consume(c.value.jti);
    hit = await s.findPendingByOrgAndEmail(ORG, 'a@x.org');
    expect(hit.ok && hit.value).toBeNull();
  });

  it('refresh extends a pending invite; NOT_FOUND once terminal', async () => {
    const s = new InMemoryRegistrationInvitesStore();
    const c = await s.create(input);
    if (!c.ok) throw new Error('seed');
    const later = new Date('2028-01-01');
    const r = await s.refresh(c.value.jti, { expiresAt: later, createdBy: 'owner2' });
    expect(r.ok && r.value.expiresAt).toEqual(later);
    expect(r.ok && r.value.createdBy).toBe('owner2');
    await s.revoke(c.value.jti);
    const r2 = await s.refresh(c.value.jti, { expiresAt: later, createdBy: 'owner2' });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error.code).toBe('NOT_FOUND');
  });

  it('consume is a single-use CAS: second consume returns null', async () => {
    const s = new InMemoryRegistrationInvitesStore();
    const c = await s.create(input);
    if (!c.ok) throw new Error('seed');
    const first = await s.consume(c.value.jti);
    expect(first.ok && first.value?.status).toBe('consumed');
    expect(first.ok && first.value?.consumedAt).toBeInstanceOf(Date);
    const second = await s.consume(c.value.jti);
    expect(second.ok && second.value).toBeNull();
  });

  it('revoke a pending invite; revoking a consumed one is a null no-op', async () => {
    const s = new InMemoryRegistrationInvitesStore();
    const c = await s.create(input);
    if (!c.ok) throw new Error('seed');
    const rev = await s.revoke(c.value.jti);
    expect(rev.ok && rev.value?.status).toBe('revoked');
    const c2 = await s.create(input);
    if (!c2.ok) throw new Error('seed2');
    await s.consume(c2.value.jti);
    const rev2 = await s.revoke(c2.value.jti);
    expect(rev2.ok && rev2.value).toBeNull();
  });

  it('release undoes a claim (consumed → pending) and only ever a consumed one', async () => {
    const s = new InMemoryRegistrationInvitesStore();
    const c = await s.create(input);
    if (!c.ok) throw new Error('seed');
    await s.consume(c.value.jti);
    const back = await s.release(c.value.jti);
    expect(back.ok && back.value?.status).toBe('pending');
    expect(back.ok && back.value?.consumedAt).toBeNull();
    // Reusable after the compensation — that is the whole point (H4).
    const again = await s.consume(c.value.jti);
    expect(again.ok && again.value?.status).toBe('consumed');
    // Releasing a pending row is a no-op, so a double-release can't un-consume
    // a claim some OTHER request is holding.
    await s.release(c.value.jti);
    const second = await s.release(c.value.jti);
    expect(second.ok && second.value).toBeNull();
  });

  it('release never resurrects a revoked invite', async () => {
    const s = new InMemoryRegistrationInvitesStore();
    const c = await s.create(input);
    if (!c.ok) throw new Error('seed');
    await s.revoke(c.value.jti);
    const back = await s.release(c.value.jti);
    expect(back.ok && back.value).toBeNull();
    const row = await s.findByJti(c.value.jti);
    expect(row.ok && row.value?.status).toBe('revoked');
  });

  it('fake.seed() sets exact row state', async () => {
    const s = new RegistrationInvitesStoreFake();
    s.seed([buildRegistrationInvite({ jti: 'seeded', status: 'pending' })]);
    const found = await s.findByJti('seeded');
    expect(found.ok && found.value?.jti).toBe('seeded');
  });
});

// ─── Postgres error mapping (fake Drizzle chain) ────────────────────────────

interface ChainCall {
  method: string;
  args: unknown[];
}
function makeFakeDb(resolve: () => unknown): unknown {
  function build(chain: ChainCall[]): unknown {
    return new Proxy(
      {},
      {
        get(_t, prop: string | symbol) {
          if (prop === 'then') {
            return (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => {
              try {
                return Promise.resolve(resolve()).then(onF, onR);
              } catch (e) {
                return onR ? Promise.resolve(onR(e)) : Promise.reject(e);
              }
            };
          }
          return (...args: unknown[]) => build([...chain, { method: String(prop), args }]);
        },
      },
    );
  }
  return build([]);
}

describe('PostgresRegistrationInvitesStore error mapping', () => {
  afterEach(() => _setDbClients(null, null));

  it('maps a Drizzle-wrapped 23505 (constraint on .cause) to DUPLICATE_PENDING', async () => {
    const db = makeFakeDb(() => {
      const pgErr = Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint: 'registration_invites_pending_unique',
      });
      throw Object.assign(new Error('Failed query: insert into "registration_invites" ...'), {
        cause: pgErr,
      });
    });
    _setDbClients(null, db as never);
    const store = new PostgresRegistrationInvitesStore();
    const res = await store.create({
      parentOrgId: ORG,
      email: 'a@x.org',
      expiresAt: new Date('2027-01-01'),
      createdBy: 'owner',
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('DUPLICATE_PENDING');
  });

  it('maps any other driver error to DB_UNAVAILABLE', async () => {
    const db = makeFakeDb(() => {
      throw new Error('connection reset');
    });
    _setDbClients(null, db as never);
    const store = new PostgresRegistrationInvitesStore();
    const res = await store.consume('some-jti');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('DB_UNAVAILABLE');
  });

  // A raw `registration_invites` row as Drizzle's inferSelect returns it.
  function rawRow(overrides: Record<string, unknown> = {}) {
    return {
      jti: 'jti-1',
      role: 'coordinator',
      parentOrgId: ORG,
      email: 'a@x.org',
      status: 'pending',
      expiresAt: new Date('2027-01-01'),
      createdBy: 'owner',
      createdAt: new Date('2026-08-01'),
      consumedAt: null,
      ...overrides,
    };
  }

  function withDb(resolve: () => unknown): PostgresRegistrationInvitesStore {
    _setDbClients(null, makeFakeDb(resolve) as never);
    return new PostgresRegistrationInvitesStore();
  }

  it('create returns the mapped row on success', async () => {
    const res = await withDb(() => [rawRow({ jti: 'j-new' })]).create({
      parentOrgId: ORG,
      email: 'a@x.org',
      expiresAt: new Date('2027-01-01'),
      createdBy: 'owner',
    });
    expect(res.ok && res.value.jti).toBe('j-new');
  });

  it('create returns DB_UNAVAILABLE when no row comes back', async () => {
    const res = await withDb(() => []).create({
      parentOrgId: ORG,
      email: 'a@x.org',
      expiresAt: new Date('2027-01-01'),
      createdBy: 'owner',
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('DB_UNAVAILABLE');
  });

  it('findByJti maps a found row / null / DB error', async () => {
    expect((await withDb(() => [rawRow({ jti: 'j-9' })]).findByJti('j-9')).ok).toBe(true);
    const found = await withDb(() => [rawRow({ jti: 'j-9' })]).findByJti('j-9');
    expect(found.ok && found.value?.jti).toBe('j-9');
    const missing = await withDb(() => []).findByJti('nope');
    expect(missing.ok && missing.value).toBeNull();
    const err = await withDb(() => {
      throw new Error('boom');
    }).findByJti('x');
    expect(err.ok).toBe(false);
  });

  it('findPendingByOrgAndEmail maps a found row', async () => {
    const res = await withDb(() => [rawRow()]).findPendingByOrgAndEmail(ORG, 'a@x.org');
    expect(res.ok && res.value?.email).toBe('a@x.org');
  });

  it('refresh returns the row on success and NOT_FOUND when no row matched', async () => {
    const ok = await withDb(() => [rawRow({ createdBy: 'owner2' })]).refresh('jti-1', {
      expiresAt: new Date('2028-01-01'),
      createdBy: 'owner2',
    });
    expect(ok.ok && ok.value.createdBy).toBe('owner2');
    const nf = await withDb(() => []).refresh('jti-1', {
      expiresAt: new Date('2028-01-01'),
      createdBy: 'owner2',
    });
    expect(nf.ok).toBe(false);
    if (nf.ok) return;
    expect(nf.error.code).toBe('NOT_FOUND');
  });

  it('consume/revoke return the row on a winning CAS and null otherwise', async () => {
    const consumed = await withDb(() => [rawRow({ status: 'consumed' })]).consume('jti-1');
    expect(consumed.ok && consumed.value?.status).toBe('consumed');
    const lost = await withDb(() => []).consume('jti-1');
    expect(lost.ok && lost.value).toBeNull();
    const revoked = await withDb(() => [rawRow({ status: 'revoked' })]).revoke('jti-1');
    expect(revoked.ok && revoked.value?.status).toBe('revoked');
  });

  it('release returns the row on a winning CAS and null otherwise', async () => {
    const released = await withDb(() => [rawRow({ status: 'pending' })]).release('jti-1');
    expect(released.ok && released.value?.status).toBe('pending');
    const lost = await withDb(() => []).release('jti-1');
    expect(lost.ok && lost.value).toBeNull();
  });
});
