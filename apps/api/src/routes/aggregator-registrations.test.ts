import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { UserStoreFake, _setUserStore, buildCoordinator } from '../services/user-store/index.js';
import { IdpAdminFake, _setIdpAdmin } from '../services/idp-admin/index.js';
import {
  OrganisationStoreFake,
  _setOrganisationStore,
  buildDefaultOrg,
} from '../services/organisation-store/index.js';
import { FakeMailer, _setMailer } from '@aggregator-dpg/mailer';
import { _resetTokenKey } from '../services/approval-token.js';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';
import { ConsentLedgerFake } from '@aggregator-dpg/consent-ledger/testing';
import { _setConsentLedger } from '../services/consent-ledger/index.js';
import { _setSubmitRateChecker } from '../services/submit-rate.js';
import { _setNetworkConfig } from '../services/network-config.js';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import type * as ConfigLoaderFs from '@aggregator-dpg/config-loader/fs';
import { NO_CONSENT_WRITE } from '../services/consent-ledger/hook.js';

const { loadConsentConfigMock } = vi.hoisted(() => ({ loadConsentConfigMock: vi.fn() }));
vi.mock('@aggregator-dpg/config-loader/fs', async (importOriginal) => {
  const actual = await importOriginal<typeof ConfigLoaderFs>();
  return { ...actual, loadConsentConfig: loadConsentConfigMock };
});

const SERVICE_BEARER = 'service-token';
const AUTH_HEADER = { authorization: `Bearer ${SERVICE_BEARER}` };

describe('POST /v1/aggregator-registrations/create', () => {
  let app: FastifyInstance;
  let userStore: UserStoreFake;
  let idp: IdpAdminFake;
  let mailer: FakeMailer;
  let consentLedger: ConsentLedgerFake;

  beforeEach(async () => {
    _resetTokenKey();
    _resetJwks();
    process.env.APPROVAL_TOKEN_SECRET = 'k'.repeat(48);
    process.env.ADMIN_EMAILS = 'reviewer@bluedots.local';
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'bluedots';

    userStore = new UserStoreFake();
    idp = new IdpAdminFake();
    mailer = new FakeMailer();
    consentLedger = new ConsentLedgerFake();

    loadConsentConfigMock.mockReset();
    const actualLoader = await vi.importActual<typeof ConfigLoaderFs>(
      '@aggregator-dpg/config-loader/fs',
    );
    loadConsentConfigMock.mockImplementation(actualLoader.loadConsentConfig);

    // Pin the limiter to always-allow: these cases are not about throttling,
    // and the default checker talks to a real Redis, where every file shares
    // the one `(ip, email)` bucket and exhausts it mid-run. Cases that DO
    // assert a 429 override this per test.
    _setSubmitRateChecker(async () => ({ allowed: true, retryAfterSeconds: 0 }));
    _setNetworkConfig(buildBlueDotConfig());

    _setUserStore(userStore);
    // These bodies register under the Default org (the only active org here).
    const orgStore = new OrganisationStoreFake();
    orgStore.seed([buildDefaultOrg()]);
    _setOrganisationStore(orgStore);
    _setIdpAdmin(idp);
    _setMailer(mailer);
    _setConsentLedger(consentLedger);
    _setAccessTokenVerifier(async (token) => {
      if (token === SERVICE_BEARER) {
        return { sub: 'service-account-aggregator-bff', azp: 'aggregator-bff' };
      }
      throw new Error('invalid token');
    });

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    _setSubmitRateChecker(null);
    _setNetworkConfig(null);
    _setUserStore(null);
    _setOrganisationStore(null);
    _setIdpAdmin(null);
    _setMailer(null);
    _setConsentLedger(null);
    _setAccessTokenVerifier(null);
  });

  const validBody = {
    org_id: buildDefaultOrg().id,
    name: 'TRRAIN',
    type: 'seeker',
    contact: {
      name: 'Asha Kumari',
      phone: '+919876543210',
      email: 'asha@trrain.org',
    },
    consent: {
      value: true,
      given_at: '2026-01-15T10:00:00Z',
      valid_till: '2099-01-15T10:00:00Z',
    },
  };

  it('creates an aggregator + disabled KC user on valid payload', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: validBody,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      aggregator_id: string;
      org_slug: string;
      message: string;
    };
    expect(body.aggregator_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.org_slug).toMatch(/^trrain-[0-9a-f]{4}$/);
    expect(body.message).toContain('Registration submitted');

    const stored = await userStore.findById(body.aggregator_id);
    if (stored.ok) expect(stored.value?.orgSlug).toBe(body.org_slug);

    const kcUser = await idp.findByEmail(validBody.contact.email);
    if (kcUser.ok && kcUser.value) {
      expect(kcUser.value.enabled).toBe(false);
      expect(kcUser.value.attributes?.aggregator_id?.[0]).toBe(body.aggregator_id);
      expect(kcUser.value.attributes?.aggregator_type?.[0]).toBe(validBody.type);
      expect(kcUser.value.attributes?.phoneNumber?.[0]).toBe(validBody.contact.phone);
      expect(kcUser.value.attributes?.decision_made?.[0]).toBe('pending');
      // Removed attributes per the new flow:
      expect(kcUser.value.attributes?.org_slug).toBeUndefined();
      expect(kcUser.value.attributes?.association).toBeUndefined();
    }

    const sent = mailer.outbox;
    expect(sent.length).toBe(1);
    const first = sent[0];
    if (!first) throw new Error('no mail captured');
    expect(first.to).toEqual(['reviewer@bluedots.local']);
    expect(first.subject).toContain('TRRAIN');
    // One review link (no per-intent URLs) → the read page carries both actions.
    expect(first.html).toContain('/admin/v1/aggregator-registrations/read/');
    expect(first.html).not.toContain('intent=');

    // Consent ledger should have one row for the aggregator
    const ledgerRows = consentLedger.list();
    expect(ledgerRows).toHaveLength(1);
    const consentRow = ledgerRows[0];
    expect(consentRow?.subjectType).toBe('user');
    expect(consentRow?.subjectId).toBe(body.aggregator_id);
    expect(consentRow?.termsVersion).toBeGreaterThanOrEqual(1);
    expect(consentRow?.privacyVersion).toBeGreaterThanOrEqual(1);
    expect(consentRow?.source).toBe('registration');
    // network/brand must come from AGGREGATOR_NETWORK/AGGREGATOR_BRAND (not a
    // different config var) so the recorded version matches what the web layer displayed.
    expect(consentRow?.network).toBe('blue_dot'); // default when AGGREGATOR_NETWORK unset
    expect(consentRow?.brand).toBeNull(); // default when AGGREGATOR_BRAND unset
  });

  it('rejects a type that is not one of the network domains (400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: { ...validBody, type: 'both' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string; fields?: Record<string, unknown> } };
    expect(body.error.code).toBe('SCHEMA_VALIDATION');
    expect(body.error.fields).toMatchObject({ type: 'invalid' });
    // Nothing was created.
    const all = await userStore.list({ status: 'pending', limit: 10, offset: 0 });
    expect(all.ok && all.value.rows.length).toBe(0);
  });

  it('records aggregator consent in the ledger on successful registration', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: validBody,
    });
    expect(res.statusCode).toBe(201);
    const { aggregator_id } = res.json() as { aggregator_id: string };

    const ledgerRows = consentLedger.list();
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]?.subjectType).toBe('user');
    expect(ledgerRows[0]?.subjectId).toBe(aggregator_id);
  });

  it('records the resolved AGGREGATOR_NETWORK and AGGREGATOR_BRAND in the consent ledger', async () => {
    process.env.AGGREGATOR_NETWORK = 'orange_dot';
    process.env.AGGREGATOR_BRAND = 'onetac';
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/aggregator-registrations/create',
        headers: AUTH_HEADER,
        payload: {
          ...validBody,
          contact: { ...validBody.contact, email: 'brand@test.org', phone: '+919999999999' },
        },
      });
      expect(res.statusCode).toBe(201);
      const ledgerRows = consentLedger.list();
      expect(ledgerRows).toHaveLength(1);
      expect(ledgerRows[0]?.network).toBe('orange_dot');
      expect(ledgerRows[0]?.brand).toBe('onetac');
    } finally {
      delete process.env.AGGREGATOR_NETWORK;
      delete process.env.AGGREGATOR_BRAND;
    }
  });

  it('fails registration (fail-closed) when the consent ledger write fails', async () => {
    // Make the ledger always return an error
    consentLedger.recordRegistrationConsent = async () => ({
      success: false as const,
      error: Object.assign(new Error('ledger down'), {
        name: 'UpstreamError',
        code: 'CONSENT_INSERT_FAILED',
      }) as BaseError,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: { ...validBody, contact: { ...validBody.contact, email: 'ledger-fail@trrain.org' } },
    });
    // Fail-closed: no consent recorded → the registration is rolled back, not 201.
    expect(res.statusCode).toBe(500);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('CONSENT_WRITE_FAILED');
    // One transaction (0029): the row never existed, so nothing is left behind.
    const found = await userStore.findByContactEmail('ledger-fail@trrain.org');
    expect(found.ok && found.value).toBeNull();
  });

  it('returns 401 when Bearer is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      payload: validBody,
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when Bearer is invalid', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: { authorization: 'Bearer junk' },
      payload: validBody,
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects payload missing required fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: { name: 'X' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string; title: string; requestId: string } };
    expect(body.error.code).toBe('SCHEMA_VALIDATION');
    expect(body.error.title).toBeTruthy();
    expect(body.error.requestId).toMatch(/^req-/);
  });

  it('rejects malformed email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: { ...validBody, contact: { ...validBody.contact, email: 'not-an-email' } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 409 when the email already exists in Keycloak', async () => {
    await idp.createUser({ email: validBody.contact.email });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: validBody,
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: { code: string; title: string; detail: string } };
    expect(body.error.code).toBe('USER_EXISTS');
    expect(body.error.title).toBe('Email already in use');
    expect(body.error.detail).toContain('already registered');
  });

  it('returns 409 when the phone is already used by another user', async () => {
    await idp.createUser({
      email: 'someone-else@trrain.org',
      phone: '+919876543210',
      attributes: { aggregator_id: 'other-agg' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: {
        ...validBody,
        contact: { ...validBody.contact, email: 'asha2@trrain.org' },
      },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: { code: string; title: string; requestId: string } };
    expect(body.error.code).toBe('PHONE_EXISTS');
    expect(body.error.title).toBe('Phone already in use');
    expect(body.error.requestId).toMatch(/^req-/);
  });

  it('rolls back the aggregator row when KC createUser fails', async () => {
    // Monkey-patch createUser to fail while leaving findByEmail untouched.
    const originalCreate = idp.createUser.bind(idp);
    idp.createUser = async () => ({
      ok: false as const,
      error: { code: 'IDP_UNAVAILABLE' as const, message: 'kc down' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: {
        ...validBody,
        contact: { ...validBody.contact, email: 'asha2@trrain.org' },
      },
    });
    expect(res.statusCode).toBe(503);

    // No aggregator row should remain — the route rolls it back when KC
    // creation fails.
    const allByPrefix = await Promise.all(
      ['trrain-0001', 'trrain-0002', 'trrain-0003'].map((s) => userStore.findBySlug(s)),
    );
    for (const r of allByPrefix) if (r.ok) expect(r.value).toBeNull();

    idp.createUser = originalCreate;
  });

  it('400 NAME_INVALID_CHARACTERS, row rolled back, when the IdP refuses the name', async () => {
    const originalCreate = idp.createUser.bind(idp);
    idp.createUser = async () => ({
      ok: false as const,
      error: { code: 'INVALID_NAME' as const, message: 'name has a refused character' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: {
        ...validBody,
        contact: { ...validBody.contact, name: 'Asha (Field)', email: 'asha3@trrain.org' },
      },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('NAME_INVALID_CHARACTERS');
    idp.createUser = originalCreate;
  });

  async function seedPending(overrides?: {
    status?: 'pending' | 'inactive' | 'active';
    rejectedAt?: Date;
  }) {
    const created = await userStore.create({
      recordConsent: NO_CONSENT_WRITE,
      orgSlug: 'trrain-aaaa',
      name: 'TRRAIN',
      type: 'seeker',
      orgId: '00000000-0000-0000-0000-0000000000d0',
      contact: {
        name: 'Asha Kumari',
        phone: '+919876543210',
        email: 'asha@trrain.org',
      },
      consent: validBody.consent,
      createdBy: 'self',
      updatedBy: 'self',
    });
    if (!created.ok) throw new Error('seed failed');
    const id = created.value.id;
    if (overrides?.status === 'inactive') {
      // Mirror the reject path: stamp write-once rejected_at (#726).
      await userStore.update(id, {
        status: 'inactive',
        rejectedAt: overrides.rejectedAt ?? new Date(),
        updatedBy: 'admin',
      });
    } else if (overrides?.status && overrides.status !== 'pending') {
      await userStore.updateStatus(id, overrides.status, 'admin');
    }
    await idp.createUser({
      email: 'asha@trrain.org',
      phone: '+919876543210',
      enabled: false,
      attributes: {
        aggregator_id: id,
        aggregator_type: 'seeker',
        phoneNumber: '+919876543210',
        decision_made: overrides?.status === 'inactive' ? 'rejected' : 'pending',
      },
    });
    return id;
  }

  it('refreshes a pending registration on resubmit instead of 409', async () => {
    const id = await seedPending();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: validBody,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { aggregator_id: string; status: string };
    expect(body.aggregator_id).toBe(id);
    expect(body.status).toBe('pending');
    // A fresh admin-review email was re-sent.
    expect(mailer.outbox.length).toBe(1);
    expect(mailer.outbox[0]?.html).toContain('/admin/v1/aggregator-registrations/read/');
  });

  it('returns 409 REGISTRATION_COOLING for a rejected registration inside the cooling window', async () => {
    const id = await seedPending({ status: 'inactive' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: validBody,
    });
    // Just-rejected → still cooling (#726): blocked with a retry_after hint.
    expect(res.statusCode).toBe(409);
    const err = res.json() as { error: { code: string; fields?: { retry_after?: string } } };
    expect(err.error.code).toBe('REGISTRATION_COOLING');
    expect(err.error.fields?.retry_after).toBeTruthy();
    // Row untouched — no revive, no email.
    const stored = await userStore.findById(id);
    if (stored.ok) expect(stored.value?.status).toBe('inactive');
    expect(mailer.outbox.length).toBe(0);
  });

  it('revives a rejected registration once the cooling window has elapsed', async () => {
    const elapsed = new Date(Date.now() - 13 * 60 * 60 * 1000); // 13h ago > 12h default
    const id = await seedPending({ status: 'inactive', rejectedAt: elapsed });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: validBody,
    });
    // Cooling elapsed → the SAME row is revived to pending and the review link
    // re-sent (reuse, not delete). rejected_at is cleared.
    expect(res.statusCode).toBe(200);
    const body = res.json() as { aggregator_id: string; status: string };
    expect(body.aggregator_id).toBe(id);
    expect(body.status).toBe('pending');
    const stored = await userStore.findById(id);
    if (stored.ok) {
      expect(stored.value?.status).toBe('pending');
      expect(stored.value?.rejectedAt).toBeNull();
    }
    expect(mailer.outbox.length).toBe(1);
    expect(mailer.outbox[0]?.html).toContain('/admin/v1/aggregator-registrations/read/');
  });

  it('still returns 409 when the email belongs to an active aggregator', async () => {
    await seedPending({ status: 'active' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: validBody,
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('USER_EXISTS');
  });

  it('re-mint on a pending record does NOT overwrite the on-file identity (no takeover)', async () => {
    const id = await seedPending(); // asha@trrain.org / +919876543210, pending
    // A stranger resubmits the victim's email with their OWN phone + name.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: {
        ...validBody,
        name: 'Attacker Org',
        contact: { ...validBody.contact, name: 'Attacker', phone: '+919999999999' },
      },
    });
    expect(res.statusCode).toBe(200);
    // The on-file record is unchanged — the submitted phone/name are ignored.
    const stored = await userStore.findById(id);
    if (stored.ok && stored.value) {
      expect(stored.value.contact.phone).toBe('+919876543210');
      expect(stored.value.name).toBe('TRRAIN');
    }
    // KC OTP identity (phoneNumber) is unchanged too.
    const kc = await idp.findByEmail('asha@trrain.org');
    if (kc.ok && kc.value) {
      expect(kc.value.attributes?.phoneNumber?.[0]).toBe('+919876543210');
    }
    // The review link was re-sent (to the reviewer, not the caller).
    expect(mailer.outbox.length).toBe(1);
  });

  it('400 SCHEMA_VALIDATION when `type` is not a domain declared by the active network (Ajv)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: { ...validBody, type: 'not-a-real-domain' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('SCHEMA_VALIDATION');
  });

  it('503 DB_UNAVAILABLE when findByContactEmail fails', async () => {
    userStore.findByContactEmail = async () => ({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'db down' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: validBody,
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe('DB_UNAVAILABLE');
  });

  it('503 DB_UNAVAILABLE when findByContactPhone fails', async () => {
    userStore.findByContactPhone = async () => ({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'db down' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: validBody,
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe('DB_UNAVAILABLE');
  });

  it('409 PHONE_EXISTS when the phone already exists in the DB (no matching KC user)', async () => {
    // A prior aggregator row already holds this phone (e.g. KC user was
    // separately cleaned up but the DB row remains) — the DB-level phone
    // uniqueness check must still catch it before any KC calls happen.
    userStore.seed([
      buildCoordinator({
        id: '33333333-3333-3333-3333-333333333333',
        orgSlug: 'other-org',
        contact: { name: 'Other', phone: '+919876543210', email: 'other@other.org' },
        status: 'pending',
      }),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: validBody, // same phone +919876543210, different email
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('PHONE_EXISTS');
  });

  it('503 IDP_UNAVAILABLE when idp.findByEmail fails', async () => {
    idp.findByEmail = async () => ({
      ok: false,
      error: { code: 'IDP_UNAVAILABLE', message: 'kc down' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: validBody,
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe('IDP_UNAVAILABLE');
  });

  it('503 IDP_UNAVAILABLE when idp.findByAttribute(phoneNumber) fails', async () => {
    idp.findByAttribute = async () => ({
      ok: false,
      error: { code: 'IDP_UNAVAILABLE', message: 'kc down' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: validBody,
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe('IDP_UNAVAILABLE');
  });

  it.each([
    ['DUPLICATE_SLUG', 503, 'DUPLICATE_SLUG'],
    ['DUPLICATE_PHONE', 409, 'PHONE_EXISTS'],
    ['DUPLICATE_EMAIL', 409, 'USER_EXISTS'],
    ['CHECK_VIOLATION', 400, 'SCHEMA_VALIDATION'],
    ['DB_UNAVAILABLE', 503, 'DB_UNAVAILABLE'],
    ['NOT_FOUND', 503, 'DB_UNAVAILABLE'],
  ] as const)('maps userStore.create error %s to %d %s', async (storeCode, status, errCode) => {
    userStore.create = async () => ({
      ok: false,
      error: { code: storeCode, message: 'store error' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: validBody,
    });
    expect(res.statusCode).toBe(status);
    expect((res.json() as { error: { code: string } }).error.code).toBe(errCode);
  });

  it('500 CONSENT_WRITE_FAILED (rolled back) when the consent config fails to load', async () => {
    loadConsentConfigMock.mockRejectedValueOnce(new Error('disk error'));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: {
        ...validBody,
        contact: { ...validBody.contact, email: 'consent-fail@trrain.org' },
      },
    });
    expect(res.statusCode).toBe(500);
    expect((res.json() as { error: { code: string } }).error.code).toBe('CONSENT_WRITE_FAILED');
    const found = await userStore.findByContactEmail('consent-fail@trrain.org');
    expect(found.ok && found.value).toBeNull();
  });

  it('409 USER_EXISTS (rolled back) when idp.createUser races to USER_EXISTS after the pre-check passed', async () => {
    idp.createUser = async () => ({
      ok: false,
      error: { code: 'USER_EXISTS', message: 'race: user created concurrently' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: { ...validBody, contact: { ...validBody.contact, email: 'race@trrain.org' } },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('USER_EXISTS');
    const found = await userStore.findByContactEmail('race@trrain.org');
    expect(found.ok && found.value).toBeNull();
  });

  it('clamps a consent valid_till far beyond the max validity window to the server ceiling', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: {
        ...validBody,
        contact: { ...validBody.contact, email: 'long-consent@trrain.org' },
        consent: {
          value: true,
          given_at: '2026-01-15T10:00:00Z',
          valid_till: '2099-01-15T10:00:00Z',
        },
      },
    });
    expect(res.statusCode).toBe(201);
    const { aggregator_id } = res.json() as { aggregator_id: string };
    const stored = await userStore.findById(aggregator_id);
    if (stored.ok && stored.value) {
      const validTill = new Date(stored.value.consent?.valid_till ?? 0).getTime();
      const now = Date.now();
      const fiveYearsMs = 5 * 365 * 24 * 60 * 60 * 1000;
      // Clamped well under the requested 2099 date, at ~5 years from now.
      expect(validTill).toBeLessThan(now + fiveYearsMs + 60_000);
      expect(validTill).toBeGreaterThan(now + fiveYearsMs - 60_000);
    }
    // What the ledger row itself stores (0029: the only home of consent).
    const row = consentLedger.list().find((r) => r.subjectId === aggregator_id);
    const ledgerTill = row?.validTill?.getTime() ?? 0;
    const fiveYears = 5 * 365 * 24 * 60 * 60 * 1000;
    expect(ledgerTill).toBeGreaterThan(Date.now() + fiveYears - 60_000);
    expect(ledgerTill).toBeLessThan(Date.now() + fiveYears + 60_000);
  });

  it('400 SCHEMA_VALIDATION for a consent that is already expired; nothing is created', async () => {
    const before = consentLedger.list().length;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: {
        ...validBody,
        contact: { ...validBody.contact, email: 'expired-consent@trrain.org' },
        consent: {
          value: true,
          given_at: '2020-01-15T10:00:00Z',
          valid_till: '2020-02-15T10:00:00Z',
        },
      },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('SCHEMA_VALIDATION');
    const found = await userStore.findByContactEmail('expired-consent@trrain.org');
    expect(found.ok && found.value).toBeNull();
    expect(consentLedger.list()).toHaveLength(before);
  });
  it('throttles a submit when the rate checker denies, with the org hierarchy off (429)', async () => {
    // The limiter used to sit inside the `orgHierarchyEnabled()` branch, so a
    // flat-mode deployment — the shape this whole file exercises — accepted
    // unlimited submissions on a route that provisions a KC user and sends mail.
    _setSubmitRateChecker(async () => ({ allowed: false, retryAfterSeconds: 42 }));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: validBody,
    });
    expect(res.statusCode).toBe(429);
    expect((res.json() as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
    expect(res.headers['retry-after']).toBe('42');
  });

  it('creates nothing when the submit limiter denies', async () => {
    _setSubmitRateChecker(async () => ({ allowed: false, retryAfterSeconds: 1 }));
    await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: validBody,
    });
    // Throttled before any provisioning — no KC user and no mail.
    const kcUser = await idp.findByEmail(validBody.contact.email);
    expect(kcUser.ok && kcUser.value).toBeNull();
    expect(mailer.outbox.length).toBe(0);
  });
});
