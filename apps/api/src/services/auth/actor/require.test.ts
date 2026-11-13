/**
 * Unit tests for the console route guard `requireActor`.
 *
 * Drives token verification with `_setAccessTokenVerifier` and pins the
 * resolved caller with the `ActorResolverFake`, so every rejection branch
 * (missing/bad token, wrong client, service account, unprovisioned, not
 * approved, coordinator on an admin route, admin without an active org, store
 * failure) and the two admit paths are exercised without a live Keycloak.
 *
 * @module @aggregator-dpg/api
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { _setAccessTokenVerifier } from '../access-token.js';
import { HttpError } from '../../../errors/http-error.js';
import { ActorResolverFake, buildAdminActor, _setActorResolver } from './index.js';
import { requireActor } from './require.js';

const SUBJECT = 'kc-sub-1';

function reqWithClaims(claims: Record<string, unknown>): FastifyRequest {
  _setAccessTokenVerifier(async () => claims);
  return { headers: { authorization: 'Bearer stub' } } as unknown as FastifyRequest;
}

async function expectHttp(p: Promise<unknown>, code: string): Promise<void> {
  await expect(p).rejects.toSatisfy((e) => e instanceof HttpError && e.code === code);
}

describe('requireActor', () => {
  let resolver: ActorResolverFake;

  beforeEach(() => {
    delete process.env.KEYCLOAK_ALLOWED_AZP;
    resolver = new ActorResolverFake();
    _setActorResolver(resolver);
  });

  afterEach(() => {
    _setAccessTokenVerifier(null);
    _setActorResolver(null);
    delete process.env.KEYCLOAK_ALLOWED_AZP;
  });

  it('UNAUTHORIZED when no Bearer token is present', async () => {
    const req = { headers: {} } as unknown as FastifyRequest;
    await expectHttp(requireActor(req), 'UNAUTHORIZED');
  });

  it('FORBIDDEN when the token client is not allow-listed', async () => {
    process.env.KEYCLOAK_ALLOWED_AZP = 'aggregator-portal';
    const req = reqWithClaims({ sub: SUBJECT, azp: 'some-other-client' });
    await expectHttp(requireActor(req), 'FORBIDDEN');
  });

  it('FORBIDDEN for a service-account token', async () => {
    const req = reqWithClaims({ sub: SUBJECT, preferred_username: 'service-account-aggregator-bff' });
    await expectHttp(requireActor(req), 'FORBIDDEN');
  });

  it('DB_UNAVAILABLE when the actor resolver fails', async () => {
    resolver.failWith = 'store down';
    const req = reqWithClaims({ sub: SUBJECT, preferred_username: 'asha' });
    await expectHttp(requireActor(req), 'DB_UNAVAILABLE');
  });

  it('USER_NOT_PROVISIONED when the token maps to no account', async () => {
    const req = reqWithClaims({ sub: SUBJECT, preferred_username: 'asha' });
    await expectHttp(requireActor(req), 'USER_NOT_PROVISIONED');
  });

  it('NOT_APPROVED for a coordinator whose registration is not active', async () => {
    resolver.seed(SUBJECT, {
      userId: 'c1',
      userType: 'coordinator',
      active: false,
      orgs: [],
    });
    const req = reqWithClaims({ sub: SUBJECT, preferred_username: 'asha' });
    await expectHttp(requireActor(req, { allowCoordinator: true }), 'NOT_APPROVED');
  });

  it('FORBIDDEN for an approved coordinator on an admin-only route', async () => {
    resolver.seed(SUBJECT, { userId: 'c1', userType: 'coordinator', active: true, orgs: [] });
    const req = reqWithClaims({ sub: SUBJECT, preferred_username: 'asha' });
    await expectHttp(requireActor(req), 'FORBIDDEN');
  });

  it('admits an approved coordinator when allowCoordinator is set', async () => {
    const actor = { userId: 'c1', userType: 'coordinator' as const, active: true, orgs: [] };
    resolver.seed(SUBJECT, actor);
    const req = reqWithClaims({ sub: SUBJECT, preferred_username: 'asha' });
    const caller = await requireActor(req, { allowCoordinator: true });
    expect(caller.actor).toEqual(actor);
    expect(caller.auth.subject).toBe(SUBJECT);
  });

  it('NOT_ORG_ADMIN for an admin owning no active org', async () => {
    resolver.seed(SUBJECT, buildAdminActor({ active: false, orgs: [] }));
    const req = reqWithClaims({ sub: SUBJECT, preferred_username: 'owner' });
    await expectHttp(requireActor(req), 'NOT_ORG_ADMIN');
  });

  it('admits an admin owning an active org', async () => {
    resolver.seed(SUBJECT, buildAdminActor());
    const req = reqWithClaims({ sub: SUBJECT, preferred_username: 'owner' });
    const caller = await requireActor(req);
    expect(caller.actor.userType).toBe('admin');
  });

  it('passes an aggregator_id claim through to the resolver', async () => {
    const actor = { userId: 'c1', userType: 'coordinator' as const, active: true, orgs: [] };
    resolver.seed('agg-99', actor);
    const req = reqWithClaims({
      sub: SUBJECT,
      aggregator_id: 'agg-99',
      preferred_username: 'asha',
    });
    const caller = await requireActor(req, { allowCoordinator: true });
    expect(caller.actor).toEqual(actor);
  });
});
