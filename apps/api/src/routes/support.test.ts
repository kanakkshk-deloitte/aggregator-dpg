// Flag-gated by SUPPORT_EMAIL; set it before any import that pulls in
// `config` (config.ts parses env once, at first import). The unset-flag
// scenarios live in the sibling `support.disabled.test.ts` file instead of
// toggling this env var mid-file, since the parsed `config` singleton can't
// be swapped once app.js has been imported. Mirrors the
// `aggregator-org-approvals.test.ts` / `.org.test.ts` split for
// ORG_HIERARCHY_ENABLED.
//
// Multiple TO addresses + a CC address exercise the comma-separated
// normalisation in `supportEmail()` / `supportCc()` (both read live env).
process.env.SUPPORT_EMAIL = 'support@org.com, ops@org.com';
process.env.SUPPORT_CC_EMAIL = 'cc@org.com';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { FakeMailer, _setMailer } from '../services/mailer/index.js';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';

/** A complete, valid submission body; override per-test. */
function validBody(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Asha K',
    email: 'asha@example.com',
    phone: '+919000000000',
    type: 'complaint',
    details: 'It broke',
    consent: true,
    ...overrides,
  };
}

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

  it('sends the support email to all TO + CC recipients and returns 201, with Reply-To + reference', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/support',
      headers: { authorization: 'Bearer good-token' },
      payload: validBody({ details: 'It broke' }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ ok: true });
    // L1: the generated reference is returned to the caller (parity with signals-dpg).
    expect((res.json() as { reference: string }).reference).toMatch(/^SUP-\d{8}-[A-Z0-9]{6}$/);

    expect(mailer.outbox).toHaveLength(1);
    const sent = mailer.outbox[0]!;
    // Multiple TO addresses normalised to a comma-joined list.
    expect(sent.to).toBe('support@org.com, ops@org.com');
    expect(sent.cc).toBe('cc@org.com');
    expect(sent.replyTo).toBe('asha@example.com');
    expect(sent.subject).toMatch(/^Issue Number: SUP-\d{8}-[A-Z0-9]{6} — Complaint from Asha K/);
    expect(sent.html).toContain('It broke');
    expect(sent.text).toContain('It broke');
  });

  it('uses the SUBMITTED (editable) name/email/phone, not the token claims', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/support',
      headers: { authorization: 'Bearer good-token' },
      payload: validBody({
        name: 'Different Name',
        email: 'typed@example.com',
        phone: '+911112223334',
        type: 'support_request',
      }),
    });
    expect(res.statusCode).toBe(201);
    const sent = mailer.outbox[0]!;
    expect(sent.subject).toContain('Support Request from Different Name');
    expect(sent.replyTo).toBe('typed@example.com');
    expect(sent.text).toContain('typed@example.com');
    expect(sent.text).toContain('+911112223334');
  });

  it('returns 400 when consent is not true and does not send anything', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/support',
      headers: { authorization: 'Bearer good-token' },
      payload: validBody({ consent: false }),
    });
    expect(res.statusCode).toBe(400);
    expect(mailer.outbox).toHaveLength(0);
  });

  it('returns 400 when neither email nor phone is provided', async () => {
    const body = validBody();
    delete (body as Record<string, unknown>).email;
    delete (body as Record<string, unknown>).phone;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/support',
      headers: { authorization: 'Bearer good-token' },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(mailer.outbox).toHaveLength(0);
  });

  it('accepts a submission with only a phone (no email) and adds no Reply-To', async () => {
    const body = validBody();
    delete (body as Record<string, unknown>).email;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/support',
      headers: { authorization: 'Bearer good-token' },
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    const sent = mailer.outbox[0]!;
    expect(sent.replyTo).toBeUndefined();
  });

  it('returns 400 for empty details and does not send anything', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/support',
      headers: { authorization: 'Bearer good-token' },
      payload: validBody({ details: '' }),
    });
    expect(res.statusCode).toBe(400);
    expect(mailer.outbox).toHaveLength(0);
  });

  it('returns 400 for whitespace-only details and does not send anything (M1)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/support',
      headers: { authorization: 'Bearer good-token' },
      payload: validBody({ details: '   ' }),
    });
    expect(res.statusCode).toBe(400);
    expect(mailer.outbox).toHaveLength(0);
  });

  it('returns 401 without a Bearer token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/support',
      payload: validBody(),
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
      payload: validBody(),
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
