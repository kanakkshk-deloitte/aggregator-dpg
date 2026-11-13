// Org approval routes (always registered since 0028).

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import {
  OrganisationStoreFake,
  buildOrganisation,
  _setOrganisationStore,
} from '../services/organisation-store/index.js';
import { IdpAdminFake, _setIdpAdmin } from '../services/idp-admin/index.js';
import { FakeMailer, _setMailer } from '@aggregator-dpg/mailer';
import { mintApprovalToken, _resetTokenKey } from '../services/approval-token.js';
import { _resetJwks } from '../services/auth/access-token.js';

describe('aggregator-org-approvals routes', () => {
  let app: FastifyInstance;
  let orgStore: OrganisationStoreFake;
  let idp: IdpAdminFake;
  let mailer: FakeMailer;

  beforeEach(async () => {
    _resetTokenKey();
    _resetJwks();
    process.env.APPROVAL_TOKEN_SECRET = 'k'.repeat(48);
    process.env.ADMIN_EMAILS = 'reviewer@bluedots.local';
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'bluedots';

    orgStore = new OrganisationStoreFake();
    idp = new IdpAdminFake();
    mailer = new FakeMailer();

    _setOrganisationStore(orgStore);
    _setIdpAdmin(idp);
    _setMailer(mailer);

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    _setOrganisationStore(null);
    _setIdpAdmin(null);
    _setMailer(null);
  });

  it('approve flips org to active, enables the owner with the role and group, and mails a sign-in link (Phase 5)', async () => {
    const orgId = '00000000-0000-0000-0000-0000000000a1';
    const owner = await idp.createUser({
      email: 'owner@x.org',
      enabled: false,
      attributes: { decision_made: 'pending' },
    });
    if (!owner.ok) throw new Error('seed');
    const group = await idp.createGroup('org-x', { org_id: orgId });
    if (!group.ok) throw new Error('seed');
    orgStore.seed([
      buildOrganisation({
        id: orgId,
        slug: 'x',
        ownerEmail: 'owner@x.org',
        ownerKcSub: owner.value.id,
        kcGroupId: group.value.id,
        status: 'pending',
      }),
    ]);
    const { token } = await mintApprovalToken({ aggregatorId: orgId, intent: 'approve' });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/orgs/decision/${orgId}`,
      payload: { token, decision: 'approve' },
    });
    expect(res.statusCode).toBe(200);
    const stored = await orgStore.findById(orgId);
    expect(stored.ok && stored.value?.status).toBe('active');
    const kc = await idp.findById(owner.value.id);
    // Phase 5: the owner signs in to the console, so approval enables them.
    expect(kc.ok && kc.value?.enabled).toBe(true);
    expect(idp.rolesOf(owner.value.id)).toContain('org_owner');
    expect(idp.groupsOf(owner.value.id)).toContain(group.value.id);
    // The mail carries a sign-in link, no 90-day grant.
    expect(mailer.outbox.length).toBe(1);
    const ownerMsg = mailer.outbox[0];
    if (!ownerMsg) throw new Error('expected an owner email in the outbox');
    expect(ownerMsg.to).toBe('owner@x.org');
    expect(ownerMsg.subject).toContain('approved');
    expect(ownerMsg.html).toContain('Sign in');
    expect(ownerMsg.html).toContain('/login');
    expect(ownerMsg.html).not.toContain('grant=');
    // Attributed to the signed link.
    expect(stored.ok && stored.value?.status).toBe('active');
  });

  it('double-clicked approve commits once (atomic single-use guard)', async () => {
    const orgId = '00000000-0000-0000-0000-0000000000a2';
    const owner = await idp.createUser({ email: 'o2@x.org', enabled: false });
    if (!owner.ok) throw new Error('seed');
    orgStore.seed([
      buildOrganisation({
        id: orgId,
        slug: 'y',
        ownerEmail: 'o2@x.org',
        ownerKcSub: owner.value.id,
        status: 'pending',
      }),
    ]);
    const { token } = await mintApprovalToken({ aggregatorId: orgId, intent: 'approve' });
    const first = await app.inject({
      method: 'POST',
      url: `/admin/v1/orgs/decision/${orgId}`,
      payload: { token, decision: 'approve' },
    });
    const second = await app.inject({
      method: 'POST',
      url: `/admin/v1/orgs/decision/${orgId}`,
      payload: { token, decision: 'approve' },
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.body).toContain('already');
  });

  it('reject sets the org inactive', async () => {
    const orgId = '00000000-0000-0000-0000-0000000000a3';
    orgStore.seed([buildOrganisation({ id: orgId, slug: 'z', status: 'pending' })]);
    const { token } = await mintApprovalToken({ aggregatorId: orgId, intent: 'reject' });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/orgs/decision/${orgId}`,
      payload: { token, decision: 'reject', reason: 'duplicate' },
    });
    expect(res.statusCode).toBe(200);
    const stored = await orgStore.findById(orgId);
    expect(stored.ok && stored.value?.status).toBe('inactive');
  });

  it('reject notifies the owner and includes the reason', async () => {
    const orgId = '00000000-0000-0000-0000-0000000000b1';
    orgStore.seed([
      buildOrganisation({
        id: orgId,
        slug: 'notify',
        status: 'pending',
        displayName: 'Notify Org',
        ownerEmail: 'owner@notify.org',
      }),
    ]);
    const { token } = await mintApprovalToken({ aggregatorId: orgId, intent: 'reject' });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/orgs/decision/${orgId}`,
      payload: { token, decision: 'reject', reason: 'Registration details do not match.' },
    });
    expect(res.statusCode).toBe(200);
    // The org reject path used to change status silently while the result page
    // claimed the applicant had been notified.
    expect(mailer.outbox.length).toBe(1);
    const sent = mailer.outbox[0]!;
    expect(sent.to).toBe('owner@notify.org');
    expect(sent.html).toContain('Registration details do not match.');
    // Wording is org-specific, not the coordinator default.
    expect(sent.subject).toContain('organisation');
    // The page confirms the owner was notified (no address echoed).
    expect(res.body).toContain('The owner has been notified.');
  });

  it('refuses a rejection without a reason (400) and leaves the org pending', async () => {
    const orgId = '00000000-0000-0000-0000-0000000000b2';
    orgStore.seed([
      buildOrganisation({
        id: orgId,
        slug: 'noreason',
        status: 'pending',
        ownerEmail: 'owner@noreason.org',
      }),
    ]);
    const { token } = await mintApprovalToken({ aggregatorId: orgId, intent: 'reject' });
    for (const reason of [undefined, '   ']) {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/v1/orgs/decision/${orgId}`,
        payload: { token, decision: 'reject', ...(reason === undefined ? {} : { reason }) },
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('Give a reason when rejecting an organisation.');
    }
    const stored = await orgStore.findById(orgId);
    expect(stored.ok && stored.value?.status).toBe('pending');
    expect(mailer.outbox).toHaveLength(0);
  });

  it('GET read page renders the confirm page for a pending org', async () => {
    const orgId = '00000000-0000-0000-0000-0000000000a4';
    orgStore.seed([
      buildOrganisation({ id: orgId, slug: 'w', displayName: 'Wonder Org', status: 'pending' }),
    ]);
    const { token } = await mintApprovalToken({ aggregatorId: orgId, intent: 'approve' });
    const res = await app.inject({
      method: 'GET',
      url: `/admin/v1/orgs/read/${orgId}?token=${encodeURIComponent(token)}&intent=approve`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Wonder Org');
  });

  it('refuses a reason over the cap with its own message (400)', async () => {
    const orgId = '00000000-0000-0000-0000-0000000000b3';
    orgStore.seed([buildOrganisation({ id: orgId, slug: 'longreason', status: 'pending' })]);
    const { token } = await mintApprovalToken({ aggregatorId: orgId, intent: 'reject' });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/orgs/decision/${orgId}`,
      payload: { token, decision: 'reject', reason: 'x'.repeat(501) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('The reason can be at most 500 characters.');
    const stored = await orgStore.findById(orgId);
    expect(stored.ok && stored.value?.status).toBe('pending');
  });

  it('GET read page asks for a reason before a rejection', async () => {
    const orgId = '00000000-0000-0000-0000-0000000000a6';
    orgStore.seed([buildOrganisation({ id: orgId, slug: 'rq', status: 'pending' })]);
    const { token } = await mintApprovalToken({ aggregatorId: orgId, intent: 'reject' });
    const res = await app.inject({
      method: 'GET',
      url: `/admin/v1/orgs/read/${orgId}?token=${encodeURIComponent(token)}&intent=reject`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/<textarea id="reason-input" name="reason" maxlength="500" required/);
  });

  it('GET read page with an expired token offers inline regenerate (§7)', async () => {
    const orgId = '00000000-0000-0000-0000-0000000000a5';
    orgStore.seed([buildOrganisation({ id: orgId, slug: 'ex', status: 'pending' })]);
    const { token } = await mintApprovalToken({
      aggregatorId: orgId,
      intent: 'approve',
      ttlSec: -1,
    });
    const res = await app.inject({
      method: 'GET',
      url: `/admin/v1/orgs/read/${orgId}?token=${encodeURIComponent(token)}&intent=approve`,
    });
    // Expired link → an explicit "regenerate" step (no self-email), which posts
    // the expired-but-signed token to the renew endpoint.
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Link expired');
    expect(res.body).toContain('Regenerate &amp; review');
    expect(res.body).toContain(`/admin/v1/orgs/renew/${orgId}`);
  });

  it('POST renew re-arms an expired token and shows the confirm page inline', async () => {
    const orgId = '00000000-0000-0000-0000-0000000000a6';
    orgStore.seed([
      buildOrganisation({ id: orgId, slug: 'rs', displayName: 'Renew Org', status: 'pending' }),
    ]);
    const { token } = await mintApprovalToken({
      aggregatorId: orgId,
      intent: 'approve',
      ttlSec: -1,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/orgs/renew/${orgId}`,
      payload: { token },
    });
    // Lands on the confirm page (approve/reject) with a fresh token; no email.
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Renew Org');
    expect(res.body).toContain(`/admin/v1/orgs/decision/${orgId}`);
    expect(mailer.outbox.length).toBe(0);
  });

  it('POST renew on an already-approved org is a no-op', async () => {
    const orgId = '00000000-0000-0000-0000-0000000000a7';
    orgStore.seed([buildOrganisation({ id: orgId, slug: 'done', status: 'active' })]);
    const { token } = await mintApprovalToken({
      aggregatorId: orgId,
      intent: 'approve',
      ttlSec: -1,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/orgs/renew/${orgId}`,
      payload: { token },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Already approved');
  });

  // ---------------------------------------------------------------------------
  // Branch coverage: missing/invalid token, store failures, already-decided
  // variants, and the decision not-found / unavailable outcomes.
  // ---------------------------------------------------------------------------

  it('GET read with no token shows the missing-token page', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/v1/orgs/read/some-id' });
    expect(res.statusCode).toBe(400);
  });

  it('GET read with a malformed token shows the invalid-token page', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/v1/orgs/read/some-id?token=not-a-jwt',
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET read returns 503 when the org store is unavailable', async () => {
    const orgId = '00000000-0000-0000-0000-0000000000c1';
    orgStore.seed([buildOrganisation({ id: orgId, slug: 'c1', status: 'pending' })]);
    orgStore.findById = async () => ({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'down' },
    });
    const { token } = await mintApprovalToken({ aggregatorId: orgId, intent: 'approve' });
    const res = await app.inject({
      method: 'GET',
      url: `/admin/v1/orgs/read/${orgId}?token=${encodeURIComponent(token)}`,
    });
    expect(res.statusCode).toBe(503);
  });

  it('GET read returns 404 for an unknown org', async () => {
    const orgId = '00000000-0000-0000-0000-0000000000c2';
    const { token } = await mintApprovalToken({ aggregatorId: orgId, intent: 'approve' });
    const res = await app.inject({
      method: 'GET',
      url: `/admin/v1/orgs/read/${orgId}?token=${encodeURIComponent(token)}`,
    });
    expect(res.statusCode).toBe(404);
  });

  it.each([
    ['active', 'Already approved'],
    ['retired', 'Already approved'],
    ['inactive', 'Already rejected'],
  ] as const)('GET read shows already-decided for a %s org', async (status, text) => {
    const orgId = `00000000-0000-0000-0000-0000000000d${status.length}`;
    orgStore.seed([buildOrganisation({ id: orgId, slug: `d-${status}`, status })]);
    const { token } = await mintApprovalToken({ aggregatorId: orgId, intent: 'approve' });
    const res = await app.inject({
      method: 'GET',
      url: `/admin/v1/orgs/read/${orgId}?token=${encodeURIComponent(token)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(text);
  });

  it('POST decision with a malformed body shows the bad-request page', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/v1/orgs/decision/some-id',
      payload: { token: '', decision: 'maybe' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST decision with an invalid token shows the invalid-token page', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/v1/orgs/decision/some-id',
      payload: { token: 'not-a-jwt', decision: 'approve' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST decision reject notes a failed owner notification', async () => {
    const orgId = '00000000-0000-0000-0000-0000000000e1';
    orgStore.seed([
      buildOrganisation({ id: orgId, slug: 'e1', status: 'pending', ownerEmail: 'o@e1.org' }),
    ]);
    mailer.send = async () => ({ ok: false, error: { code: 'TRANSPORT_FAILED', message: 'down' } });
    const { token } = await mintApprovalToken({ aggregatorId: orgId, intent: 'reject' });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/orgs/decision/${orgId}`,
      payload: { token, decision: 'reject', reason: 'duplicate' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('could not be delivered');
  });

  it('POST decision returns 404 for an unknown org', async () => {
    const orgId = '00000000-0000-0000-0000-0000000000e2';
    const { token } = await mintApprovalToken({ aggregatorId: orgId, intent: 'approve' });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/orgs/decision/${orgId}`,
      payload: { token, decision: 'approve' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST decision returns 503 when the org store is unavailable', async () => {
    const orgId = '00000000-0000-0000-0000-0000000000e3';
    orgStore.findById = async () => ({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'down' },
    });
    const { token } = await mintApprovalToken({ aggregatorId: orgId, intent: 'approve' });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/orgs/decision/${orgId}`,
      payload: { token, decision: 'approve' },
    });
    expect(res.statusCode).toBe(503);
  });

  it('POST renew with no body shows the invalid-token page', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/v1/orgs/renew/some-id' });
    expect(res.statusCode).toBe(400);
  });

  it('POST renew returns 503 when the org store is unavailable', async () => {
    const orgId = '00000000-0000-0000-0000-0000000000f1';
    orgStore.seed([buildOrganisation({ id: orgId, slug: 'f1', status: 'pending' })]);
    orgStore.findById = async () => ({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'down' },
    });
    const { token } = await mintApprovalToken({
      aggregatorId: orgId,
      intent: 'approve',
      ttlSec: -1,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/orgs/renew/${orgId}`,
      payload: { token },
    });
    expect(res.statusCode).toBe(503);
  });

  it('POST renew returns 404 for an unknown org', async () => {
    const orgId = '00000000-0000-0000-0000-0000000000f2';
    const { token } = await mintApprovalToken({
      aggregatorId: orgId,
      intent: 'approve',
      ttlSec: -1,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/orgs/renew/${orgId}`,
      payload: { token },
    });
    expect(res.statusCode).toBe(404);
  });
});
