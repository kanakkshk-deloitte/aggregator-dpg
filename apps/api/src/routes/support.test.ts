// Flag-gated by SUPPORT_EMAIL; set it before any import that pulls in
// `config` (config.ts parses env once, at first import). The unset-flag
// scenarios live in the sibling `support.disabled.test.ts` file instead of
// toggling this env var mid-file, since the parsed `config` singleton can't
// be swapped once app.js has been imported. Mirrors the
// `aggregator-org-approvals.test.ts` / `.org.test.ts` split for
// ORG_HIERARCHY_ENABLED.
process.env.SUPPORT_EMAIL = 'support@org.com';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { FakeMailer, _setMailer } from '../services/mailer/index.js';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';

describe('support routes (SUPPORT_EMAIL configured)', () => {
  let app: FastifyInstance;
  let mailer: FakeMailer;

  beforeEach(async () => {
    _resetJwks();
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'aggregator';
    _setAccessTokenVerifier(async (token) => {
      if (token === 'good-token') {
        return {
          sub: 'u1',
          aggregator_id: 'agg-9',
          email: 'asha@example.com',
          preferred_username: 'Asha K',
          phone_number: '+919000000000',
        };
      }
      throw new Error('invalid token');
    });

    mailer = new FakeMailer();
    _setMailer(mailer);

    app = await buildApp();
  });

  afterEach(async () => {
    await app?.close();
    _setMailer(null);
    _setAccessTokenVerifier(null);
  });

  it('sends the support email and returns 201, with Reply-To set to the submitter', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/support',
      headers: { authorization: 'Bearer good-token' },
      payload: { subject: 'Help', message: 'It broke' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ ok: true });

    expect(mailer.outbox).toHaveLength(1);
    const sent = mailer.outbox[0]!;
    expect(sent.to).toBe('support@org.com');
    expect(sent.replyTo).toBe('asha@example.com');
    expect(sent.subject).toContain('Help');
    expect(sent.html).toContain('It broke');
    expect(sent.text).toContain('It broke');
  });

  it('returns 400 for an empty message and does not send anything', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/support',
      headers: { authorization: 'Bearer good-token' },
      payload: { message: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(mailer.outbox).toHaveLength(0);
  });

  it('returns 401 without a Bearer token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/support',
      payload: { message: 'hi' },
    });
    expect(res.statusCode).toBe(401);
    expect(mailer.outbox).toHaveLength(0);
  });

  it('returns 502 SUPPORT_SEND_FAILED when the mailer send fails', async () => {
    mailer.failOnce({ code: 'TRANSPORT_FAILED', message: 'smtp down' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/support',
      headers: { authorization: 'Bearer good-token' },
      payload: { message: 'hi' },
    });
    expect(res.statusCode).toBe(502);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('SUPPORT_SEND_FAILED');
  });

  it('GET /v1/support/config reports enabled=true', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/support/config',
      headers: { authorization: 'Bearer good-token' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: true });
  });

  it('GET /v1/support/config requires auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/support/config' });
    expect(res.statusCode).toBe(401);
  });
});
