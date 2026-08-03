/**
 * Tests for the client-scoping controls added to token verification:
 * the `azp` allow-list gate (`KEYCLOAK_ALLOWED_AZP`) applied on both the
 * user (`authenticate`) and service (`authenticateAny`) paths.
 *
 * `aud` validation is delegated to jose's `jwtVerify` (exercised only with a
 * real signed token + JWKS) and so is not covered here — these tests drive the
 * post-verify `azp` gate via the test verifier override.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { authenticate, authenticateAny, _setAccessTokenVerifier } from './access-token.js';
import type { FastifyRequest } from 'fastify';

const aggregatorId = '11111111-1111-1111-1111-111111111111';

function makeReq(claims: Record<string, unknown>): FastifyRequest {
  _setAccessTokenVerifier(async () => claims);
  return { headers: { authorization: 'Bearer stub' } } as unknown as FastifyRequest;
}

afterEach(() => {
  _setAccessTokenVerifier(null);
  delete process.env.KEYCLOAK_ALLOWED_AZP;
});

describe('azp allow-list gate', () => {
  it('is disabled when KEYCLOAK_ALLOWED_AZP is unset (any azp passes)', async () => {
    const req = makeReq({ sub: 'service-account-x', azp: 'some-unknown-client' });
    const result = await authenticateAny(req);
    expect(result.ok).toBe(true);
  });

  it('accepts a token whose azp is in the allow-list', async () => {
    process.env.KEYCLOAK_ALLOWED_AZP = 'aggregator-portal, aggregator-api';
    const req = makeReq({ sub: 'service-account-x', azp: 'aggregator-api' });
    const result = await authenticateAny(req);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.context.authorizedParty).toBe('aggregator-api');
  });

  it('rejects a token whose azp is not in the allow-list', async () => {
    process.env.KEYCLOAK_ALLOWED_AZP = 'aggregator-portal,aggregator-api';
    const req = makeReq({ sub: 'service-account-x', azp: 'attacker-client' });
    const result = await authenticateAny(req);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_TOKEN');
  });

  it('rejects a token with no azp when the allow-list is configured', async () => {
    process.env.KEYCLOAK_ALLOWED_AZP = 'aggregator-api';
    const req = makeReq({ sub: 'service-account-x' });
    const result = await authenticateAny(req);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_TOKEN');
  });

  it('also gates the user path (authenticate): disallowed azp is rejected before aggregator_id is read', async () => {
    process.env.KEYCLOAK_ALLOWED_AZP = 'aggregator-portal';
    const req = makeReq({ sub: 'user-1', aggregator_id: aggregatorId, azp: 'attacker-client' });
    const result = await authenticate(req);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_TOKEN');
  });

  it('allows the user path when azp is permitted', async () => {
    process.env.KEYCLOAK_ALLOWED_AZP = 'aggregator-portal';
    const req = makeReq({ sub: 'user-1', aggregator_id: aggregatorId, azp: 'aggregator-portal' });
    const result = await authenticate(req);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.context.aggregatorId).toBe(aggregatorId);
  });
});
