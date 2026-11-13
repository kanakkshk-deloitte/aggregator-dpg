// Coordinator submit with an org (the org hierarchy is always on since 0028).

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { UserStoreFake, _setUserStore } from '../services/user-store/index.js';
import {
  OrganisationStoreFake,
  buildOrganisation,
  buildDefaultOrg,
  _setOrganisationStore,
} from '../services/organisation-store/index.js';
import { verifyApprovalToken } from '../services/approval-token.js';
import { IdpAdminFake, _setIdpAdmin } from '../services/idp-admin/index.js';
import { FakeMailer, _setMailer } from '@aggregator-dpg/mailer';
import { _resetTokenKey } from '../services/approval-token.js';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';
import { _setSubmitRateChecker } from '../services/submit-rate.js';
import { ConsentLedgerFake } from '@aggregator-dpg/consent-ledger/testing';
import { _setConsentLedger } from '../services/consent-ledger/index.js';

const SERVICE_BEARER = 'service-token';
const AUTH_HEADER = { authorization: `Bearer ${SERVICE_BEARER}` };

describe('coordinator submit with an org', () => {
  let app: FastifyInstance;
  let userStore: UserStoreFake;
  let orgStore: OrganisationStoreFake;
  let idp: IdpAdminFake;
  let mailer: FakeMailer;

  const validBody = {
    name: 'TRRAIN',
    type: 'seeker',
    contact: { name: 'Asha Kumari', phone: '+919876543210', email: 'asha@trrain.org' },
    consent: { value: true, given_at: '2026-01-15T10:00:00Z', valid_till: '2099-01-15T10:00:00Z' },
  };

  beforeEach(async () => {
    _resetTokenKey();
    _resetJwks();
    // Permissive by default, NOT `null`. `null` restores the Redis-backed
    // limiter, whose bucket is keyed `ip|email` — constant across this file —
    // so the fourth submit in the file 429s and which tests fail depends on
    // the wall-clock window. The one case that asserts throttling installs its
    // own denying checker.
    _setSubmitRateChecker(async () => ({ allowed: true, retryAfterSeconds: 0 }));
    process.env.APPROVAL_TOKEN_SECRET = 'k'.repeat(48);
    process.env.ADMIN_EMAILS = 'reviewer@bluedots.local';
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'bluedots';

    userStore = new UserStoreFake();
    orgStore = new OrganisationStoreFake();
    idp = new IdpAdminFake();
    mailer = new FakeMailer();

    _setUserStore(userStore);
    _setOrganisationStore(orgStore);
    _setIdpAdmin(idp);
    _setMailer(mailer);
    _setConsentLedger(new ConsentLedgerFake());
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
    _setUserStore(null);
    _setOrganisationStore(null);
    _setIdpAdmin(null);
    _setMailer(null);
    _setAccessTokenVerifier(null);
    _setSubmitRateChecker(null);
    _setConsentLedger(null);
  });

  it('rejects coordinator submit when no active org exists (bootstrap)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: { ...validBody, org_id: 'missing' },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('TARGET_ORG_INACTIVE');
  });

  it('rejects coordinator submit when org_id is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: validBody,
    });
    expect(res.statusCode).toBe(400);
  });

  it('sets parent_org_id from the chosen active org', async () => {
    orgStore.seed([
      buildOrganisation({ id: 'org-1', slug: 'o', status: 'active', ownerEmail: 'owner@o.org' }),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: { ...validBody, org_id: 'org-1' },
    });
    expect(res.statusCode).toBe(201);
    const id = (res.json() as { aggregator_id: string }).aggregator_id;
    const stored = await userStore.findById(id);
    expect(stored.ok && stored.value?.parentOrgId).toBe('org-1');
  });

  it('returns OWNER_ALREADY_REGISTERED when the coordinator email is an org owner', async () => {
    orgStore.seed([
      buildOrganisation({
        id: 'org-1',
        slug: 'o',
        status: 'active',
        ownerEmail: 'asha@trrain.org',
      }),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: { ...validBody, org_id: 'org-1' },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('OWNER_ALREADY_REGISTERED');
  });

  it('throttles a submit when the rate checker denies (429)', async () => {
    orgStore.seed([
      buildOrganisation({ id: 'org-1', slug: 'o', status: 'active', ownerEmail: 'owner@o.org' }),
    ]);
    _setSubmitRateChecker(async () => ({ allowed: false, retryAfterSeconds: 42 }));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: { ...validBody, org_id: 'org-1' },
    });
    expect(res.statusCode).toBe(429);
  });

  it('503 DB_UNAVAILABLE when the org store lookup fails', async () => {
    orgStore.findById = async () => ({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'db down' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: { ...validBody, org_id: 'org-1' },
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe('DB_UNAVAILABLE');
  });

  describe('the Default org (0028)', () => {
    const DEFAULT_ID = buildDefaultOrg().id;
    const submit = (payload: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: '/v1/aggregator-registrations/create',
        headers: AUTH_HEADER,
        payload,
      });
    const reviewLink = () => {
      const html = mailer.outbox.at(-1)?.html ?? '';
      const m = /token=([A-Za-z0-9._-]+)/.exec(html);
      return { to: mailer.outbox.at(-1)?.to, token: m?.[1] ?? '' };
    };

    it('refuses a body without org_id or an invite (Phase 5: the one-release fallback is gone)', async () => {
      orgStore.seed([buildDefaultOrg()]);
      const res = await submit({ ...validBody, url: 'https://own.example' });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: { code: string } }).error.code).toBe('SCHEMA_VALIDATION');
    });

    it("keeps a Default-org coordinator's own org details", async () => {
      orgStore.seed([buildDefaultOrg()]);
      const res = await submit({ ...validBody, org_id: DEFAULT_ID, url: 'https://own.example' });
      expect(res.statusCode).toBe(201);
      const id = (res.json() as { aggregator_id: string }).aggregator_id;
      const stored = await userStore.findById(id);
      expect(stored.ok && stored.value?.parentOrgId).toBe(DEFAULT_ID);
      expect(stored.ok && stored.value?.isDefaultOrg).toBe(true);
      // The Default org has no shared value: the coordinator keeps its own.
      expect(stored.ok && stored.value?.url).toBe('https://own.example');
    });

    it('is selectable while it is the only active org', async () => {
      orgStore.seed([buildDefaultOrg()]);
      const res = await submit({ ...validBody, org_id: DEFAULT_ID });
      expect(res.statusCode).toBe(201);
    });

    it('is not selectable once a real org is active', async () => {
      orgStore.seed([
        buildDefaultOrg(),
        buildOrganisation({ id: 'org-1', slug: 'o', status: 'active', ownerEmail: 'o@o.org' }),
      ]);
      const res = await submit({ ...validBody, org_id: DEFAULT_ID });
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: { code: string } }).error.code).toBe('TARGET_ORG_INACTIVE');
    });

    it('rejects the organisation name "Default"', async () => {
      orgStore.seed([buildDefaultOrg()]);
      const res = await submit({ ...validBody, name: ' default ', org_id: DEFAULT_ID });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: { code: string } }).error.code).toBe('SCHEMA_VALIDATION');
    });

    it('routes the review to ADMIN_EMAILS with the Default org claim when no owner is configured', async () => {
      delete process.env.DEFAULT_ORG_OWNER_EMAIL;
      orgStore.seed([buildDefaultOrg()]);
      expect((await submit({ ...validBody, org_id: DEFAULT_ID })).statusCode).toBe(201);
      const { to, token } = reviewLink();
      expect(to).toEqual(['reviewer@bluedots.local']);
      const v = await verifyApprovalToken(token);
      expect(v.ok && v.org).toBe(DEFAULT_ID);
    });

    it('routes the review to DEFAULT_ORG_OWNER_EMAIL when configured', async () => {
      process.env.DEFAULT_ORG_OWNER_EMAIL = 'default.owner@bluedots.local';
      try {
        orgStore.seed([buildDefaultOrg()]);
        expect((await submit({ ...validBody, org_id: DEFAULT_ID })).statusCode).toBe(201);
        expect(reviewLink().to).toEqual(['default.owner@bluedots.local']);
      } finally {
        delete process.env.DEFAULT_ORG_OWNER_EMAIL;
      }
    });

    it('routes a reclaimed (resubmitted) Default registration like a fresh one', async () => {
      process.env.DEFAULT_ORG_OWNER_EMAIL = 'default.owner@bluedots.local';
      try {
        orgStore.seed([buildDefaultOrg()]);
        expect((await submit({ ...validBody, org_id: DEFAULT_ID })).statusCode).toBe(201);
        mailer.outbox.length = 0;
        // Same person resubmits while still pending: the review link is re-sent.
        const again = await submit({ ...validBody, org_id: DEFAULT_ID });
        expect(again.statusCode).toBe(200);
        const { to, token } = reviewLink();
        expect(to).toEqual(['default.owner@bluedots.local']);
        const v = await verifyApprovalToken(token);
        expect(v.ok && v.org).toBe(DEFAULT_ID);
      } finally {
        delete process.env.DEFAULT_ORG_OWNER_EMAIL;
      }
    });

    it("refuses url / locations for a real org (they are the org's; Phase 5)", async () => {
      orgStore.seed([
        buildOrganisation({ id: 'org-1', slug: 'o', status: 'active', ownerEmail: 'o@o.org' }),
      ]);
      const res = await submit({ ...validBody, org_id: 'org-1', url: 'https://own.example' });
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: { code: string } }).error.code).toBe('ORG_DETAILS_READ_ONLY');
      expect((await userStore.findByContactEmail(validBody.contact.email)).ok).toBe(true);
    });
  });
});
