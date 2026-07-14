// Deliberately does NOT set SUPPORT_EMAIL — exercises the "not configured"
// branch. Kept in a separate file (rather than toggling the env var mid-file
// alongside support.test.ts) because `config.SUPPORT_EMAIL` is parsed once
// at first import of `config.ts` and can't be swapped between tests in the
// same module registry. Mirrors the `aggregator-orgs.test.ts` /
// `.org.test.ts` split used for ORG_HIERARCHY_ENABLED elsewhere in this
// package.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';

describe('support routes (SUPPORT_EMAIL unset)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    delete process.env.SUPPORT_EMAIL;
    _resetJwks();
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'aggregator';
    _setAccessTokenVerifier(async (token) => {
      if (token === 'good-token') {
        return { sub: 'u1', aggregator_id: 'agg-9', email: 'asha@example.com' };
      }
      throw new Error('invalid token');
    });

    app = await buildApp();
  });

  afterEach(async () => {
    await app?.close();
    _setAccessTokenVerifier(null);
  });

  it('returns 503 SUPPORT_NOT_CONFIGURED when SUPPORT_EMAIL is unset', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/support',
      headers: { authorization: 'Bearer good-token' },
      payload: { message: 'hi' },
    });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('SUPPORT_NOT_CONFIGURED');
  });

  it('GET /v1/support/config reports enabled=false', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/support/config',
      headers: { authorization: 'Bearer good-token' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: false });
  });
});
