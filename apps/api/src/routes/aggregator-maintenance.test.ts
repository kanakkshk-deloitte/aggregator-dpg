import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { UserStoreFake, buildCoordinator, _setUserStore } from '../services/user-store/index.js';
import { IdpAdminFake, _setIdpAdmin } from '../services/idp-admin/index.js';
import {
  OrganisationStoreFake,
  _setOrganisationStore,
} from '../services/organisation-store/index.js';
import { FakeMailer, _setMailer } from '@aggregator-dpg/mailer';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';

const SERVICE_BEARER = 'service-token';
const AUTH_HEADER = { authorization: `Bearer ${SERVICE_BEARER}` };

describe('POST /admin/v1/aggregator-registrations/cleanup-stale', () => {
  let app: FastifyInstance;
  let userStore: UserStoreFake;
  let idp: IdpAdminFake;
  let mailer: FakeMailer;

  beforeEach(async () => {
    _resetJwks();
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'bluedots';

    userStore = new UserStoreFake();
    idp = new IdpAdminFake();
    mailer = new FakeMailer();

    _setUserStore(userStore);
    // The stale-org prune always runs since 0028; no stale orgs here.
    _setOrganisationStore(new OrganisationStoreFake());
    _setIdpAdmin(idp);
    _setMailer(mailer);
    _setAccessTokenVerifier(async (token) => {
      if (token === SERVICE_BEARER) {
        return {
          sub: '3f1c2b9e-0000-4000-8000-00000000b0ff',
          azp: 'aggregator-bff',
          preferred_username: 'service-account-aggregator-bff',
        };
      }
      throw new Error('invalid token');
    });

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    _setUserStore(null);
    _setOrganisationStore(null);
    _setIdpAdmin(null);
    _setMailer(null);
    _setAccessTokenVerifier(null);
  });

  it('prunes only stale pending registrations and their KC users', async () => {
    // Fresh pending — last touched now, well within the grace window → survives.
    const fresh = buildCoordinator({
      id: '11111111-1111-1111-1111-111111111111',
      orgSlug: 'fresh-aaaa',
      contact: { name: 'Fresh', phone: '+919000000001', email: 'fresh@x.org' },
      contactPhone: '+919000000001',
      contactEmail: 'fresh@x.org',
      status: 'pending',
      updatedAt: new Date(),
    });
    // Stale pending — last touched in 2020, far past TTL + grace → pruned.
    const stale = buildCoordinator({
      id: '22222222-2222-2222-2222-222222222222',
      orgSlug: 'stale-bbbb',
      contact: { name: 'Stale', phone: '+919000000002', email: 'stale@x.org' },
      contactPhone: '+919000000002',
      contactEmail: 'stale@x.org',
      status: 'pending',
      updatedAt: new Date('2020-01-01T00:00:00Z'),
    });
    userStore.seed([fresh, stale]);
    // KC user is keyed by the stored aggregator_id attribute (not email).
    await idp.createUser({
      email: 'stale@x.org',
      enabled: false,
      attributes: { aggregator_id: stale.id },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/admin/v1/aggregator-registrations/cleanup-stale',
      headers: AUTH_HEADER,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { scanned: number; pruned: number; prunedIds: string[] };
    expect(body.pruned).toBe(1);
    expect(body.prunedIds).toContain(stale.id);
    expect(body.prunedIds).not.toContain(fresh.id);

    const goneKc = await idp.findByEmail('stale@x.org');
    if (goneKc.ok) expect(goneKc.value).toBeNull();

    const staleRow = await userStore.findById(stale.id);
    if (staleRow.ok) expect(staleRow.value).toBeNull();
    const freshRow = await userStore.findById(fresh.id);
    if (freshRow.ok) expect(freshRow.value).not.toBeNull();
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/v1/aggregator-registrations/cleanup-stale',
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns zero counts when nothing is stale', async () => {
    userStore.seed([
      buildCoordinator({
        id: '33333333-3333-3333-3333-333333333333',
        orgSlug: 'recent-cccc',
        contact: { name: 'Recent', phone: '+919000000003', email: 'recent@x.org' },
        contactPhone: '+919000000003',
        contactEmail: 'recent@x.org',
        status: 'pending',
        updatedAt: new Date(),
      }),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/admin/v1/aggregator-registrations/cleanup-stale',
      headers: AUTH_HEADER,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { scanned: number; pruned: number };
    // scanned counts only stale rows now (age-filtered in SQL); the fresh row
    // is excluded, so nothing is scanned or pruned.
    expect(body.scanned).toBe(0);
    expect(body.pruned).toBe(0);
  });

  it('rejects a non-service-account (end-user) token with 403', async () => {
    // A plain user token verifies but must not be able to trigger deletion.
    const USER_BEARER = 'user-token';
    _setAccessTokenVerifier(async (token) => {
      if (token === USER_BEARER) {
        return { sub: '9c1e2f00-user-uuid', aggregator_id: 'agg-1' };
      }
      if (token === SERVICE_BEARER) {
        return {
          sub: '3f1c2b9e-0000-4000-8000-00000000b0ff',
          azp: 'aggregator-bff',
          preferred_username: 'service-account-aggregator-bff',
        };
      }
      throw new Error('invalid token');
    });
    const res = await app.inject({
      method: 'POST',
      url: '/admin/v1/aggregator-registrations/cleanup-stale',
      headers: { authorization: `Bearer ${USER_BEARER}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('skips (does not prune) a stale row when the KC user lookup fails', async () => {
    // Stale pending row — old enough to be pruned.
    const stale = buildCoordinator({
      id: '44444444-4444-4444-4444-444444444444',
      orgSlug: 'stale-dddd',
      contact: { name: 'LookupFail', phone: '+919000000004', email: 'lookup-fail@x.org' },
      contactPhone: '+919000000004',
      contactEmail: 'lookup-fail@x.org',
      status: 'pending',
      updatedAt: new Date('2020-01-01T00:00:00Z'),
    });
    userStore.seed([stale]);
    // Prune resolves the KC user by the stored aggregator_id attribute; patch
    // findByAttribute to error, simulating Keycloak unreachable during lookup.
    const originalFindByAttribute = idp.findByAttribute.bind(idp);
    idp.findByAttribute = async (name: string, value: string) => {
      if (value === stale.id) {
        return {
          ok: false as const,
          error: { code: 'IDP_UNAVAILABLE' as const, message: 'kc down' },
        };
      }
      return originalFindByAttribute(name, value);
    };

    const res = await app.inject({
      method: 'POST',
      url: '/admin/v1/aggregator-registrations/cleanup-stale',
      headers: AUTH_HEADER,
    });

    // Restore original method.
    idp.findByAttribute = originalFindByAttribute;

    expect(res.statusCode).toBe(200);
    const body = res.json() as { scanned: number; pruned: number; prunedIds: string[] };
    // The row must NOT have been deleted — unknown KC state means skip, not prune.
    expect(body.pruned).toBe(0);
    expect(body.prunedIds).not.toContain(stale.id);
    // DB row still present — re-tryable on next pass.
    const row = await userStore.findById(stale.id);
    if (row.ok) expect(row.value).not.toBeNull();
  });

  it('skips (does not prune) a stale row when the KC user delete fails', async () => {
    const stale = buildCoordinator({
      id: '55555555-5555-5555-5555-555555555555',
      orgSlug: 'stale-eeee',
      contact: { name: 'DeleteFail', phone: '+919000000005', email: 'delete-fail@x.org' },
      contactPhone: '+919000000005',
      contactEmail: 'delete-fail@x.org',
      status: 'pending',
      updatedAt: new Date('2020-01-01T00:00:00Z'),
    });
    userStore.seed([stale]);
    await idp.createUser({
      email: 'delete-fail@x.org',
      enabled: false,
      attributes: { aggregator_id: stale.id },
    });
    idp.deleteUser = async () => ({
      ok: false,
      error: { code: 'IDP_UNAVAILABLE', message: 'kc delete failed' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/admin/v1/aggregator-registrations/cleanup-stale',
      headers: AUTH_HEADER,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { pruned: number; prunedIds: string[] };
    expect(body.pruned).toBe(0);
    expect(body.prunedIds).not.toContain(stale.id);
    const row = await userStore.findById(stale.id);
    if (row.ok) expect(row.value).not.toBeNull();
  });

  it('skips (does not prune) a stale row when the DB row delete fails', async () => {
    const stale = buildCoordinator({
      id: '66666666-6666-6666-6666-666666666666',
      orgSlug: 'stale-ffff',
      contact: { name: 'DbFail', phone: '+919000000006', email: 'db-fail@x.org' },
      contactPhone: '+919000000006',
      contactEmail: 'db-fail@x.org',
      status: 'pending',
      updatedAt: new Date('2020-01-01T00:00:00Z'),
    });
    userStore.seed([stale]);
    userStore.deleteIfPending = async () => ({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'db delete failed' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/admin/v1/aggregator-registrations/cleanup-stale',
      headers: AUTH_HEADER,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { pruned: number; prunedIds: string[] };
    expect(body.pruned).toBe(0);
    expect(body.prunedIds).not.toContain(stale.id);
  });

  it('leaves a row decided during the prune, and its KC user, in place', async () => {
    const stale = buildCoordinator({
      id: '77777777-7777-7777-7777-777777777777',
      orgSlug: 'stale-gggg',
      contact: { name: 'Raced', phone: '+919000000007', email: 'raced@x.org' },
      contactPhone: '+919000000007',
      contactEmail: 'raced@x.org',
      status: 'pending',
      updatedAt: new Date('2020-01-01T00:00:00Z'),
    });
    userStore.seed([stale]);
    const user = await idp.createUser({
      email: 'raced@x.org',
      enabled: false,
      attributes: { aggregator_id: stale.id },
    });
    if (!user.ok) throw new Error('seed failed');
    // An approval lands between the page read and the delete.
    const lookup = idp.findByAttribute.bind(idp);
    idp.findByAttribute = async (key, value) => {
      await userStore.approveFromPending(stale.id, 'admin-1');
      return lookup(key, value);
    };

    const res = await app.inject({
      method: 'POST',
      url: '/admin/v1/aggregator-registrations/cleanup-stale',
      headers: AUTH_HEADER,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { pruned: number }).pruned).toBe(0);
    const row = await userStore.findById(stale.id);
    expect(row.ok && row.value?.status).toBe('active');
    const kc = await idp.findById(user.value.id);
    expect(kc.ok && kc.value).toBeTruthy();
  });

  it('503s when the aggregator store list fails', async () => {
    userStore.list = async () => ({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'list failed' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/admin/v1/aggregator-registrations/cleanup-stale',
      headers: AUTH_HEADER,
    });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('DB_UNAVAILABLE');
  });

  it('warns (but still 200s) when the stale-pending page hits the 1000-row cap', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) =>
      buildCoordinator({
        id: `77777777-7777-7777-7777-${String(i).padStart(12, '0')}`,
        orgSlug: `cap-org-${i}`,
        contact: {
          name: `Cap ${i}`,
          phone: `+9190000${String(i).padStart(5, '0')}`,
          email: `cap${i}@x.org`,
        },
        status: 'pending',
        updatedAt: new Date('2020-01-01T00:00:00Z'),
      }),
    );
    userStore.seed(rows);
    const res = await app.inject({
      method: 'POST',
      url: '/admin/v1/aggregator-registrations/cleanup-stale',
      headers: AUTH_HEADER,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { scanned: number };
    expect(body.scanned).toBe(1000);
  });
});
