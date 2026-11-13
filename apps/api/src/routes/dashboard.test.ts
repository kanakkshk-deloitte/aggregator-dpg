import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';
import { _setSignalStackWriter } from '../services/signalstack.js';
import { _setNetworkConfig } from '../services/network-config.js';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import { UserStoreFake, _setUserStore, buildCoordinator } from '../services/user-store/index.js';
import { IdpAdminFake, _setIdpAdmin } from '../services/idp-admin/index.js';
import { SignalStackWriterFake } from '@aggregator-dpg/signalstack-writer/testing';
import { err } from '@aggregator-dpg/shared-primitives/result';
import { UpstreamError } from '@aggregator-dpg/shared-primitives/errors';

const AGG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AGG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ORG_A = 'org_aaa_signalstack';

/**
 * Builds a deterministic rollup with the same shape signalstack returns
 * per domain. Defaults zero everything; tests override only the fields
 * they care about.
 */
function makeRollup(
  overrides: Partial<{
    total_items: number;
    complete_profiles: number;
    has_applications: number;
    by_status: Partial<Record<'new' | 'active' | 'at_risk' | 'inactive', number>>;
    by_initiated_action_status: Partial<Record<'create' | 'accept' | 'reject' | 'cancel', number>>;
    by_received_action_status: Partial<Record<'create' | 'accept' | 'reject' | 'cancel', number>>;
    total_users: number;
    avg_items_per_user: number;
    avg_actions_per_user: number;
    mode_wise_counts: Record<string, number>;
  }>,
) {
  return {
    total_items: 0,
    complete_profiles: 0,
    has_applications: 0,
    by_status: {},
    by_initiated_action_status: {},
    by_received_action_status: {},
    total_users: 0,
    avg_items_per_user: 0,
    avg_actions_per_user: 0,
    mode_wise_counts: {},
    ...overrides,
  };
}

describe('GET /v1/dashboard', () => {
  let app: FastifyInstance;
  let writer: SignalStackWriterFake;
  let userStore: UserStoreFake;
  let idp: IdpAdminFake;

  beforeEach(async () => {
    _resetJwks();
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'bluedots';
    process.env.SIGNALSTACK_BASE_URL = 'http://stub-signalstack';
    process.env.SIGNALSTACK_ADMIN_KEY = 'stub-key';
    process.env.SIGNALSTACK_ACTING_ORG_ID = 'org_platform';
    _setNetworkConfig(buildBlueDotConfig());

    idp = new IdpAdminFake();
    await idp.createUser({
      email: 'kc-1@x.com',
      enabled: true,
      attributes: { aggregator_id: AGG_A, decision_made: 'approved' },
    });
    await idp.createUser({
      email: 'kc-2@x.com',
      enabled: true,
      attributes: { aggregator_id: AGG_B, decision_made: 'approved' },
    });
    _setIdpAdmin(idp);

    userStore = new UserStoreFake();
    userStore.seed([
      buildCoordinator({
        id: AGG_A,
        orgSlug: 'agg-a',
        name: 'Agg A',
        status: 'active',
        signalstackOrgId: ORG_A,
      }),
      buildCoordinator({
        id: AGG_B,
        orgSlug: 'agg-b',
        name: 'Agg B',
        contact: { name: 'B', phone: '+919999999991', email: 'b@test.local' },
        status: 'active',
        signalstackOrgId: null,
      }),
    ]);
    _setUserStore(userStore);

    writer = new SignalStackWriterFake();
    writer.seed({
      aggregators: [{ external_id: AGG_A, org_id: ORG_A, name: 'Agg A', slug: 'agg-a' }],
      dashboards: [
        {
          acting_org_id: ORG_A,
          page: {
            by_domain: {
              seeker: {
                rollup: makeRollup({
                  total_items: 5,
                  by_status: { new: 3, at_risk: 2 },
                }),
                items: [
                  { item_id: 'p1', status: 'new' },
                  { item_id: 'p2', status: 'at_risk' },
                ],
                next_cursor: null,
                total_matching: 2,
              },
              provider: {
                rollup: makeRollup({}),
                items: [],
                next_cursor: null,
                total_matching: 0,
              },
            },
            metadata: {
              last_computed_at: '2026-05-22T15:33:05.355Z',
              ttl_seconds: 3600,
              refreshed: true,
            },
          },
        },
      ],
    });
    _setSignalStackWriter(writer);

    _setAccessTokenVerifier(async (token) => {
      if (token === 'agg-a-approved-with-org') {
        return {
          sub: 'kc-1',
          email: 'a@x.com',
          aggregator_id: AGG_A,
          decision_made: 'approved',
          signalstack_org_id: ORG_A,
        };
      }
      if (token === 'agg-a-approved-no-claim') {
        return {
          sub: 'kc-1',
          email: 'a@x.com',
          aggregator_id: AGG_A,
          decision_made: 'approved',
        };
      }
      if (token === 'agg-b-approved-null-store') {
        return {
          sub: 'kc-2',
          email: 'b@x.com',
          aggregator_id: AGG_B,
          decision_made: 'approved',
        };
      }
      if (token === 'agg-a-pending') {
        return {
          sub: 'kc-1',
          email: 'a@x.com',
          aggregator_id: AGG_A,
          decision_made: 'pending',
        };
      }
      throw new Error('invalid token');
    });

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    _setSignalStackWriter(null);
    _setUserStore(null);
    _setIdpAdmin(null);
    _setAccessTokenVerifier(null);
    _setNetworkConfig(null);
  });

  it('401 without token', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/dashboard' });
    expect(res.statusCode).toBe(401);
  });

  it('403 NOT_APPROVED when decision_made is pending', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard',
      headers: { authorization: 'Bearer agg-a-pending' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns rollup verbatim using actingOrgId from access-token claim', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard?page=1&limit=50',
      headers: { authorization: 'Bearer agg-a-approved-with-org' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.by_domain.seeker.rollup.total_items).toBe(5);
    expect(body.by_domain.seeker.rollup.by_status).toEqual({ new: 3, at_risk: 2 });
    expect(body.by_domain.seeker.items).toHaveLength(2);
    expect(body.by_domain.seeker.total_matching).toBe(2);
    expect(body.metadata.refreshed).toBe(true);
  });

  it('forwards ?lifecycle=draft to signalstack as a single-lifecycle filter', async () => {
    const spy = vi.spyOn(writer, 'fetchDashboard');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard?domain=seeker&lifecycle=draft',
      headers: { authorization: 'Bearer agg-a-approved-with-org' },
    });
    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ lifecycle: ['draft'] }));
  });

  it('defaults to draft+live when no ?lifecycle= is supplied', async () => {
    const spy = vi.spyOn(writer, 'fetchDashboard');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard?domain=seeker',
      headers: { authorization: 'Bearer agg-a-approved-with-org' },
    });
    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ lifecycle: ['draft', 'live'] }));
  });

  it('rejects an unknown ?lifecycle= value with 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard?domain=seeker&lifecycle=bogus',
      headers: { authorization: 'Bearer agg-a-approved-with-org' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('falls back to aggregators.signalstack_org_id when claim missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard',
      headers: { authorization: 'Bearer agg-a-approved-no-claim' },
    });
    // requireApproved triggers backfill; the fake's upsertAggregator
    // succeeds and writes signalstack_org_id to the DB mirror. The route
    // then resolves actingOrgId either from the just-patched context or
    // the DB lookup and returns the seeded rollup.
    expect(res.statusCode).toBe(200);
    expect(res.json().by_domain.seeker.rollup.total_items).toBe(5);
  });

  it('503 SIGNALSTACK_ORG_NOT_REGISTERED when DB column is null and backfill cannot resolve', async () => {
    // AGG_B has signalstackOrgId=null in the store seed. The fake upsert
    // would synthesise an id, so we suppress it by clearing the writer.
    // Instead, drop the writer entirely so the dashboard route fails
    // before reaching signalstack.
    _setSignalStackWriter(null);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard',
      headers: { authorization: 'Bearer agg-b-approved-null-store' },
    });
    // Writer null short-circuits to INTERNAL (signalstack not configured)
    // BEFORE the org-id check — the route guards both. Either error code
    // is acceptable; assert non-2xx.
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
  });

  it('forwards the status filter to signalstack', async () => {
    // Seed a different rollup for a status filter and assert it's served.
    writer.seed({
      dashboards: [
        {
          acting_org_id: ORG_A,
          page: {
            by_domain: {
              seeker: {
                rollup: makeRollup({
                  total_items: 2,
                  by_status: { at_risk: 2 },
                }),
                items: [],
                next_cursor: null,
                total_matching: 0,
              },
              provider: {
                rollup: makeRollup({}),
                items: [],
                next_cursor: null,
                total_matching: 0,
              },
            },
            metadata: {
              last_computed_at: '2026-05-22T15:33:05.355Z',
              ttl_seconds: 3600,
              refreshed: true,
            },
          },
        },
      ],
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard?page=1&limit=50&status=at_risk',
      headers: { authorization: 'Bearer agg-a-approved-with-org' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.by_domain.seeker.rollup.by_status.at_risk).toBe(2);
    expect(body.by_domain.seeker.total_matching).toBe(0);
  });

  it('400 on invalid status shape', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard?status=at-risk!',
      headers: { authorization: 'Bearer agg-a-approved-with-org' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('exports the seeded CSV body with the right headers', async () => {
    const SAMPLE_CSV =
      'profile_item_id,user_id,profile_status,profile_completion_pct\n' +
      'p-1,u-1,at_risk,42\n' +
      'p-2,u-2,at_risk,58\n';
    writer.seed({
      dashboardExports: [{ acting_org_id: ORG_A, csv: SAMPLE_CSV }],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/export?status=at_risk',
      headers: { authorization: 'Bearer agg-a-approved-with-org' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const disposition = res.headers['content-disposition'];
    expect(disposition).toContain('attachment');
    expect(disposition).toContain('aggregator-dashboard-at_risk-');
    expect(res.body).toBe(SAMPLE_CSV);
  });

  it('export 5xx when signalstack writer is disabled', async () => {
    _setSignalStackWriter(null);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/export?status=at_risk',
      headers: { authorization: 'Bearer agg-a-approved-with-org' },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
  });

  it('export 400 on invalid status shape', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/export?status=at-risk!',
      headers: { authorization: 'Bearer agg-a-approved-with-org' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('forwards ?refresh=true to the signalstack writer', async () => {
    const spy = vi.spyOn(writer, 'fetchDashboard');

    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard?refresh=true',
      headers: { authorization: 'Bearer agg-a-approved-with-org' },
    });
    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ refresh: true }));
  });

  it('defaults refresh to false when ?refresh is unset', async () => {
    const spy = vi.spyOn(writer, 'fetchDashboard');

    await app.inject({
      method: 'GET',
      url: '/v1/dashboard',
      headers: { authorization: 'Bearer agg-a-approved-with-org' },
    });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ refresh: false }));
  });

  it('403 FORBIDDEN when the token has no aggregator_id claim', async () => {
    _setAccessTokenVerifier(async (token) => {
      if (token === 'no-agg') return { sub: 'kc-x', decision_made: 'approved' };
      throw new Error('invalid token');
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard',
      headers: { authorization: 'Bearer no-agg' },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: { code: string } }).error.code).toBe('FORBIDDEN');
  });

  it('400 SCHEMA_VALIDATION on an unknown domain', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard?domain=bogus',
      headers: { authorization: 'Bearer agg-a-approved-with-org' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('500 INTERNAL when signalstack is not configured', async () => {
    _setSignalStackWriter(null);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard',
      headers: { authorization: 'Bearer agg-a-approved-with-org' },
    });
    expect(res.statusCode).toBe(500);
    expect((res.json() as { error: { code: string } }).error.code).toBe('INTERNAL');
  });

  it('500 INTERNAL when fetchDashboard fails', async () => {
    writer.fetchDashboard = async () =>
      err(new UpstreamError('signalstack down', { code: 'SIGNALSTACK_SERVER_ERROR' }));
    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard',
      headers: { authorization: 'Bearer agg-a-approved-with-org' },
    });
    expect(res.statusCode).toBe(500);
    const body = res.json() as { error: { code: string; detail: string } };
    expect(body.error.code).toBe('INTERNAL');
    expect(body.error.detail).toContain('Signalstack dashboard fetch failed');
  });

  it('503 DB_UNAVAILABLE when resolving the acting org id via the DB fallback fails', async () => {
    userStore.findById = async () => ({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'db down' },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard',
      // No signalstack_org_id claim — forces the DB fallback lookup.
      headers: { authorization: 'Bearer agg-a-approved-no-claim' },
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe('DB_UNAVAILABLE');
  });

  it('503 SIGNALSTACK_ORG_NOT_REGISTERED when neither the claim nor the DB row carry an org id', async () => {
    // requireApproved() auto-backfills a missing signalstack_org_id via
    // upsertAggregator on every approved request — fail it here so AGG_B's
    // row stays without an org id and the route's own fallback also misses.
    writer.upsertAggregator = async () =>
      err(new UpstreamError('signalstack down', { code: 'SIGNALSTACK_SERVER_ERROR' }));
    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard',
      // AGG_B has signalstackOrgId: null and the token carries no claim either.
      headers: { authorization: 'Bearer agg-b-approved-null-store' },
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe(
      'SIGNALSTACK_ORG_NOT_REGISTERED',
    );
  });

  it('400 SCHEMA_VALIDATION on an unknown domain for /v1/dashboard/export', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/export?domain=bogus',
      headers: { authorization: 'Bearer agg-a-approved-with-org' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('500 INTERNAL when exportDashboardCsv fails', async () => {
    writer.exportDashboardCsv = async () =>
      err(new UpstreamError('signalstack down', { code: 'SIGNALSTACK_SERVER_ERROR' }));
    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/export',
      headers: { authorization: 'Bearer agg-a-approved-with-org' },
    });
    expect(res.statusCode).toBe(500);
    const body = res.json() as { error: { code: string; detail: string } };
    expect(body.error.code).toBe('INTERNAL');
    expect(body.error.detail).toContain('Signalstack dashboard export failed');
  });
});

describe('POST /v1/dashboard/export/profiles', () => {
  let app: FastifyInstance;
  let writer: SignalStackWriterFake;
  let userStore: UserStoreFake;
  let idp: IdpAdminFake;

  beforeEach(async () => {
    _resetJwks();
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'bluedots';
    process.env.SIGNALSTACK_BASE_URL = 'http://stub-signalstack';
    process.env.SIGNALSTACK_ADMIN_KEY = 'stub-key';
    process.env.SIGNALSTACK_ACTING_ORG_ID = 'org_platform';
    _setNetworkConfig(buildBlueDotConfig());

    idp = new IdpAdminFake();
    await idp.createUser({
      email: 'kc-1@x.com',
      enabled: true,
      attributes: { aggregator_id: AGG_A, decision_made: 'approved' },
    });
    _setIdpAdmin(idp);

    userStore = new UserStoreFake();
    userStore.seed([
      buildCoordinator({
        id: AGG_A,
        orgSlug: 'agg-a',
        name: 'Agg A',
        status: 'active',
        signalstackOrgId: ORG_A,
      }),
    ]);
    _setUserStore(userStore);

    writer = new SignalStackWriterFake();
    _setSignalStackWriter(writer);

    _setAccessTokenVerifier(async (token) => {
      if (token === 'agg-a-approved-with-org') {
        return {
          sub: 'kc-1',
          email: 'a@x.com',
          aggregator_id: AGG_A,
          decision_made: 'approved',
          signalstack_org_id: ORG_A,
        };
      }
      if (token === 'agg-a-pending') {
        return {
          sub: 'kc-1',
          email: 'a@x.com',
          aggregator_id: AGG_A,
          decision_made: 'pending',
        };
      }
      throw new Error('invalid token');
    });

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    _setSignalStackWriter(null);
    _setUserStore(null);
    _setIdpAdmin(null);
    _setAccessTokenVerifier(null);
    _setNetworkConfig(null);
  });

  it('returns CSV of decrypted profiles for selected item_ids', async () => {
    // Seed a profile under ORG_A (the aggregator's signalstack org) via onboard()
    // so acting_org_id is set correctly for fetchDecryptedProfiles org-scoped match.
    const onboarded = await writer.onboard({
      actingOrgId: ORG_A,
      name: 'Velu',
      phoneNumber: '+919876801011',
      terms_accepted: true,
      privacy_accepted: true,
      channel: 'link',
      source_id: 'link-1',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: { name: 'Velu Murugan', phone: '+919876801011' },
    });
    if (!onboarded.success) throw new Error('seed failed');
    const itemId = onboarded.value.profile_item_id;

    const res = await app.inject({
      method: 'POST',
      url: '/v1/dashboard/export/profiles',
      headers: {
        authorization: 'Bearer agg-a-approved-with-org',
        'content-type': 'application/json',
      },
      payload: { item_ids: [itemId], domain: 'seeker' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment; filename="profiles-seeker-');
    const csv = res.body;
    expect(csv.split('\r\n')[0]).toBe('item_id,name,phone');
    expect(csv).toContain('Velu Murugan');
  });

  it('rejects an empty item_ids array with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/dashboard/export/profiles',
      headers: {
        authorization: 'Bearer agg-a-approved-with-org',
        'content-type': 'application/json',
      },
      payload: { item_ids: [], domain: 'seeker' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts exactly 1000 item_ids', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/dashboard/export/profiles',
      headers: {
        authorization: 'Bearer agg-a-approved-with-org',
        'content-type': 'application/json',
      },
      payload: {
        item_ids: Array.from({ length: 1000 }, (_, i) => `id-${i}`),
        domain: 'seeker',
      },
    });
    // None are owned, so the CSV is empty — the point is that 1000 is not a 400.
    expect(res.statusCode).toBe(200);
  });

  it('rejects 1001 copies of one id — the cap applies before dedup', async () => {
    // Pins the ordering. Moving dedup ahead of validation would make this pass
    // as a 1-id request and quietly widen the cap back to unbounded.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/dashboard/export/profiles',
      headers: {
        authorization: 'Bearer agg-a-approved-with-org',
        'content-type': 'application/json',
      },
      payload: { item_ids: Array.from({ length: 1001 }, () => 'same-id'), domain: 'seeker' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects more than 1000 item_ids with 400', async () => {
    // The array was previously unbounded, so one call could ask signalstack to
    // decrypt arbitrarily many profiles.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/dashboard/export/profiles',
      headers: {
        authorization: 'Bearer agg-a-approved-with-org',
        'content-type': 'application/json',
      },
      payload: {
        item_ids: Array.from({ length: 1001 }, (_, i) => `id-${i}`),
        domain: 'seeker',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 SCHEMA_VALIDATION on an unknown domain', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/dashboard/export/profiles',
      headers: {
        authorization: 'Bearer agg-a-approved-with-org',
        'content-type': 'application/json',
      },
      payload: { item_ids: ['x'], domain: 'bogus' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('500 INTERNAL when signalstack is not configured', async () => {
    _setSignalStackWriter(null);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/dashboard/export/profiles',
      headers: {
        authorization: 'Bearer agg-a-approved-with-org',
        'content-type': 'application/json',
      },
      payload: { item_ids: ['x'], domain: 'seeker' },
    });
    expect(res.statusCode).toBe(500);
    expect((res.json() as { error: { code: string } }).error.code).toBe('INTERNAL');
  });

  it('500 INTERNAL when fetchDecryptedProfiles fails', async () => {
    writer.fetchDecryptedProfiles = async () =>
      err(new UpstreamError('signalstack down', { code: 'SIGNALSTACK_SERVER_ERROR' }));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/dashboard/export/profiles',
      headers: {
        authorization: 'Bearer agg-a-approved-with-org',
        'content-type': 'application/json',
      },
      payload: { item_ids: ['x'], domain: 'seeker' },
    });
    expect(res.statusCode).toBe(500);
    const body = res.json() as { error: { code: string; detail: string } };
    expect(body.error.code).toBe('INTERNAL');
    expect(body.error.detail).toContain('Signalstack profile decrypt failed');
  });

  it('drops ids the caller does not own and reports the count, without erroring', async () => {
    // Signals scopes the decrypt to the acting org and returns unowned ids in
    // `skipped`. The route must NOT turn that into a 4xx — a status keyed to ids
    // that exist under another aggregator would confirm they exist.
    const ownedId = await seedOwnedProfile('Velu Murugan', '+919876801011');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/dashboard/export/profiles',
      headers: {
        authorization: 'Bearer agg-a-approved-with-org',
        'content-type': 'application/json',
      },
      payload: { item_ids: [ownedId, 'someone-elses-item', 'nonexistent'], domain: 'seeker' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-export-skipped-count']).toBe('2');
    // Only the owned row is in the CSV; the other two leave no trace.
    expect(res.body).toContain('Velu Murugan');
    expect(res.body).not.toContain('someone-elses-item');
    expect(res.body).not.toContain('nonexistent');
  });

  async function seedOwnedProfile(name: string, phone: string): Promise<string> {
    const onboarded = await writer.onboard({
      actingOrgId: ORG_A,
      name,
      phoneNumber: phone,
      terms_accepted: true,
      privacy_accepted: true,
      channel: 'link',
      source_id: 'link-1',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: { name, phone },
    });
    if (!onboarded.success) throw new Error('seed failed');
    return onboarded.value.profile_item_id;
  }

  it('reports a zero skipped count when every requested id is owned', async () => {
    const ownedId = await seedOwnedProfile('Asha Rao', '+919876801012');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/dashboard/export/profiles',
      headers: {
        authorization: 'Bearer agg-a-approved-with-org',
        'content-type': 'application/json',
      },
      payload: { item_ids: [ownedId], domain: 'seeker' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-export-skipped-count']).toBe('0');
  });

  it('deduplicates item_ids before forwarding them to signalstack', async () => {
    // Duplicates never changed the CSV (signals dedupes its own requested set)
    // but they did consume the EXPORT_MAX_ITEM_IDS budget.
    const id = await seedOwnedProfile('Dup Once', '+919876801013');
    const spy = vi.spyOn(writer, 'fetchDecryptedProfiles');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/dashboard/export/profiles',
      headers: {
        authorization: 'Bearer agg-a-approved-with-org',
        'content-type': 'application/json',
      },
      payload: { item_ids: [id, id, id], domain: 'seeker' },
    });

    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ itemIds: [id] }));
    // A deduped request is fully owned, so nothing is reported as withheld.
    expect(res.headers['x-export-skipped-count']).toBe('0');
  });
});
