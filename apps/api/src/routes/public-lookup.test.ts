/**
 * Tests for GET /public/v1/aggregators/:orgSlug/lookup.
 *
 * Covers the anonymous identity-probe endpoint that the registration form
 * calls before opening the schema: the route resolves the aggregator's
 * signalstack org id by slug, then wraps `SignalStackWriterBase.probeUser`
 * (an `account_only` call into signals) to classify the identity as
 *   - truly new (`user_exists: false`)
 *   - own user with no item / with lifecycle summary
 *   - foreign-owned (`owned_elsewhere: true`, lifecycle_summary null)
 *
 * @module apps/api/routes/public-lookup.test
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { UserStoreFake, _setUserStore, buildCoordinator } from '../services/user-store/index.js';
import { _setSignalStackWriter } from '../services/signalstack.js';
import { SignalStackWriterFake } from '@aggregator-dpg/signalstack-writer/testing';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';

const { consumeMock } = vi.hoisted(() => ({
  consumeMock: vi.fn().mockResolvedValue({ allowed: true, count: 1, retryAfterSeconds: 0 }),
}));
vi.mock('../services/rate-limiter/index.js', () => ({ consume: consumeMock }));

const AGG_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID = 'org-1';

describe('GET /public/v1/aggregators/:orgSlug/lookup', () => {
  let app: FastifyInstance;
  let userStore: UserStoreFake;
  let signalstack: SignalStackWriterFake;

  beforeEach(async () => {
    consumeMock.mockClear();
    consumeMock.mockResolvedValue({ allowed: true, count: 1, retryAfterSeconds: 0 });
    // Treat signalstack as enabled so getSignalStackWriter returns our fake.
    process.env.SIGNALSTACK_BASE_URL = 'http://stub-signalstack';
    process.env.SIGNALSTACK_ADMIN_KEY = 'stub-key';
    process.env.SIGNALSTACK_ACTING_ORG_ID = 'org_platform';

    userStore = new UserStoreFake();
    userStore.seed([
      buildCoordinator({
        id: AGG_ID,
        orgSlug: 'acme',
        name: 'Acme Aggregator',
        status: 'active',
        signalstackOrgId: ORG_ID,
      }),
    ]);
    _setUserStore(userStore);

    signalstack = new SignalStackWriterFake();
    _setSignalStackWriter(signalstack);

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    _setUserStore(null);
    _setSignalStackWriter(null);
  });

  it('returns user_exists=false for a new identity', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/public/v1/aggregators/acme/lookup?email=new@example.com&network=blue_dot&domain=seeker',
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      user_exists: false,
      owned_elsewhere: false,
      lifecycle_summary: null,
    });
  });

  it('returns owned_elsewhere=true with null lifecycle for a foreign user', async () => {
    signalstack.seedForeignUser({ email: 'shared@x.com' });
    const r = await app.inject({
      method: 'GET',
      url: '/public/v1/aggregators/acme/lookup?email=shared@x.com&network=blue_dot&domain=seeker',
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as {
      user_exists: boolean;
      owned_elsewhere: boolean;
      lifecycle_summary: unknown;
    };
    expect(body.user_exists).toBe(true);
    expect(body.owned_elsewhere).toBe(true);
    expect(body.lifecycle_summary).toBeNull();
  });

  it('returns lifecycle_summary for an own user with a draft item', async () => {
    signalstack.seedOwnUser({
      actingOrgId: ORG_ID,
      email: 'me@here.com',
      item: { item_id: 'item-1', lifecycle_status: 'draft' },
    });
    const r = await app.inject({
      method: 'GET',
      url: '/public/v1/aggregators/acme/lookup?email=me@here.com&network=blue_dot&domain=seeker',
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as {
      user_exists: boolean;
      owned_elsewhere: boolean;
      lifecycle_summary: {
        primary_item: { item_id: string; lifecycle_status: string };
      } | null;
    };
    expect(body.user_exists).toBe(true);
    expect(body.owned_elsewhere).toBe(false);
    expect(body.lifecycle_summary?.primary_item.item_id).toBe('item-1');
    expect(body.lifecycle_summary?.primary_item.lifecycle_status).toBe('draft');
  });

  it('400s when neither email nor phone_number is supplied', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/public/v1/aggregators/acme/lookup?network=blue_dot&domain=seeker',
    });
    expect(r.statusCode).toBe(400);
  });

  it('429s RATE_LIMITED when the per-org rate limit trips', async () => {
    consumeMock.mockResolvedValueOnce({ allowed: false, count: 21, retryAfterSeconds: 9 });
    const r = await app.inject({
      method: 'GET',
      url: '/public/v1/aggregators/acme/lookup?email=a@b.com&network=blue_dot&domain=seeker',
    });
    expect(r.statusCode).toBe(429);
    expect(r.headers['retry-after']).toBe('9');
    expect((r.json() as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
  });

  it('503s DB_UNAVAILABLE when the aggregator store lookup fails', async () => {
    userStore.findBySlug = async () => ({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'db down' },
    });
    const r = await app.inject({
      method: 'GET',
      url: '/public/v1/aggregators/acme/lookup?email=a@b.com&network=blue_dot&domain=seeker',
    });
    expect(r.statusCode).toBe(503);
    expect((r.json() as { error: { code: string } }).error.code).toBe('DB_UNAVAILABLE');
  });

  it('normalises a valid phone_number before probing signalstack', async () => {
    signalstack.seedOwnUser({
      actingOrgId: ORG_ID,
      phoneNumber: '+919876543210',
      item: { item_id: 'item-2', lifecycle_status: 'live' },
    });
    const r = await app.inject({
      method: 'GET',
      url: '/public/v1/aggregators/acme/lookup?phone_number=9876543210&network=blue_dot&domain=seeker',
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { user_exists: boolean };
    expect(body.user_exists).toBe(true);
  });

  it('400s INVALID_PHONE when phone_number cannot be normalised', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/public/v1/aggregators/acme/lookup?phone_number=123&network=blue_dot&domain=seeker',
    });
    expect(r.statusCode).toBe(400);
    expect((r.json() as { error: { code: string } }).error.code).toBe('INVALID_PHONE');
  });

  it('404s when the aggregator slug is unknown', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/public/v1/aggregators/unknown/lookup?email=a@b.com&network=blue_dot&domain=seeker',
    });
    expect(r.statusCode).toBe(404);
  });

  it('503s with SIGNALSTACK_ORG_NOT_REGISTERED when signalstack is not configured', async () => {
    _setSignalStackWriter(null);
    const r = await app.inject({
      method: 'GET',
      url: '/public/v1/aggregators/acme/lookup?email=a@b.com&network=blue_dot&domain=seeker',
    });
    expect(r.statusCode).toBe(503);
    expect((r.json() as { error: { code: string } }).error.code).toBe(
      'SIGNALSTACK_ORG_NOT_REGISTERED',
    );
  });

  it('502s with SIGNALSTACK_PROBE_FAILED when the signalstack probe errors', async () => {
    signalstack.probeUser = async () => ({
      success: false,
      error: Object.assign(new Error('signalstack unreachable'), {
        name: 'UpstreamError',
        code: 'SIGNALSTACK_SERVER_ERROR',
      }) as BaseError,
    });
    const r = await app.inject({
      method: 'GET',
      url: '/public/v1/aggregators/acme/lookup?email=a@b.com&network=blue_dot&domain=seeker',
    });
    expect(r.statusCode).toBe(502);
    const body = r.json() as { error: { code: string; detail: string; fields?: { code: string } } };
    expect(body.error.code).toBe('SIGNALSTACK_PROBE_FAILED');
    expect(body.error.detail).toContain('signalstack unreachable');
    expect(body.error.fields?.code).toBe('SIGNALSTACK_SERVER_ERROR');
  });
});
