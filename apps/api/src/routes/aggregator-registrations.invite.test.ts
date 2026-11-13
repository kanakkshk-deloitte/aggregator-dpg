// Coordinator submit with an invite token (#700).

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { UserStoreFake, buildCoordinator, _setUserStore } from '../services/user-store/index.js';
import {
  OrganisationStoreFake,
  buildOrganisation,
  _setOrganisationStore,
} from '../services/organisation-store/index.js';
import {
  RegistrationInvitesStoreFake,
  buildRegistrationInvite,
  _setRegistrationInvitesStore,
} from '../services/registration-invites-store/index.js';
import { IdpAdminFake, _setIdpAdmin } from '../services/idp-admin/index.js';
import { FakeMailer, _setMailer } from '@aggregator-dpg/mailer';
import { _resetTokenKey } from '../services/approval-token.js';
import { mintInviteToken, _resetInviteTokenKey } from '../services/invite-token.js';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';
import { _setSubmitRateChecker } from '../services/submit-rate.js';
import { ConsentLedgerFake } from '@aggregator-dpg/consent-ledger/testing';
import { _setConsentLedger } from '../services/consent-ledger/index.js';

const SERVICE_BEARER = 'service-token';
const AUTH_HEADER = { authorization: `Bearer ${SERVICE_BEARER}` };
const ORG_ID = '00000000-0000-0000-0000-0000000000c1';
const INVITE_EMAIL = 'asha@trrain.org';

describe('coordinator submit with an invite token (#700)', () => {
  let app: FastifyInstance;
  let userStore: UserStoreFake;
  let orgStore: OrganisationStoreFake;
  let invites: RegistrationInvitesStoreFake;

  const validBody = {
    name: 'TRRAIN',
    type: 'seeker',
    contact: { name: 'Asha Kumari', phone: '+919876543210', email: INVITE_EMAIL },
    consent: { value: true, given_at: '2026-01-15T10:00:00Z', valid_till: '2099-01-15T10:00:00Z' },
  };

  /** Seed a pending invite for (ORG_ID, INVITE_EMAIL) and mint a token for it. */
  async function seedInviteAndToken(
    overrides: Parameters<typeof buildRegistrationInvite>[0] = {},
  ): Promise<string> {
    const invite = buildRegistrationInvite({
      jti: 'inv-1',
      parentOrgId: ORG_ID,
      email: INVITE_EMAIL,
      status: 'pending',
      ...overrides,
    });
    invites.seed([invite]);
    const { token } = await mintInviteToken({
      jti: invite.jti,
      org: invite.parentOrgId,
      email: invite.email,
    });
    return token;
  }

  beforeEach(async () => {
    _resetTokenKey();
    _resetInviteTokenKey();
    _resetJwks();
    // Pin the limiter to always-allow: these cases are not about throttling,
    // and the default checker talks to a real Redis, where every file shares
    // the one `(ip, email)` bucket and exhausts it mid-run. Cases that DO
    // assert a 429 override this per test.
    _setSubmitRateChecker(async () => ({ allowed: true, retryAfterSeconds: 0 }));
    process.env.APPROVAL_TOKEN_SECRET = 'k'.repeat(48);
    process.env.ADMIN_EMAILS = 'reviewer@bluedots.local';
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'bluedots';

    userStore = new UserStoreFake();
    orgStore = new OrganisationStoreFake();
    invites = new RegistrationInvitesStoreFake();

    _setUserStore(userStore);
    _setOrganisationStore(orgStore);
    _setRegistrationInvitesStore(invites);
    _setIdpAdmin(new IdpAdminFake());
    _setMailer(new FakeMailer());
    _setConsentLedger(new ConsentLedgerFake());
    _setAccessTokenVerifier(async (token) => {
      if (token === SERVICE_BEARER) {
        return { sub: 'service-account-aggregator-bff', azp: 'aggregator-bff' };
      }
      throw new Error('invalid token');
    });
    orgStore.seed([
      buildOrganisation({ id: ORG_ID, slug: 'o', status: 'active', ownerEmail: 'owner@o.org' }),
    ]);

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    _setUserStore(null);
    _setOrganisationStore(null);
    _setRegistrationInvitesStore(null);
    _setIdpAdmin(null);
    _setMailer(null);
    _setAccessTokenVerifier(null);
    _setSubmitRateChecker(null);
    _setConsentLedger(null);
  });

  function post(payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload,
    });
  }

  it('accepts a valid invite: stamps parent_org_id from the claim and consumes the invite', async () => {
    const token = await seedInviteAndToken();
    userStore.seedInviteEmail('inv-1', INVITE_EMAIL);
    const res = await post({ ...validBody, invite: token });
    expect(res.statusCode).toBe(201);
    const id = (res.json() as { aggregator_id: string }).aggregator_id;
    const stored = await userStore.findById(id);
    expect(stored.ok && stored.value?.parentOrgId).toBe(ORG_ID);
    // The row links the consumed invite (0029); the invited address is read
    // through it (the fake mirrors the Postgres join).
    expect(stored.ok && stored.value?.inviteId).toBe('inv-1');
    expect(stored.ok && stored.value?.inviteEmail).toBe(INVITE_EMAIL);
    // Invite is now consumed (single-use).
    const inv = await invites.findByJti('inv-1');
    expect(inv.ok && inv.value?.status).toBe('consumed');
  });

  it('allows registering with a different email and records the invited one (#701)', async () => {
    const token = await seedInviteAndToken();
    userStore.seedInviteEmail('inv-1', INVITE_EMAIL);
    const res = await post({
      ...validBody,
      contact: { ...validBody.contact, email: 'my-own@trrain.org' },
      invite: token,
    });
    expect(res.statusCode).toBe(201);
    const id = (res.json() as { aggregator_id: string }).aggregator_id;
    const stored = await userStore.findById(id);
    // Registered with the entered email; invited email kept as provenance.
    expect(stored.ok && stored.value?.contact.email).toBe('my-own@trrain.org');
    // The row links the consumed invite (0029); the invited address is read
    // through it (the fake mirrors the Postgres join).
    expect(stored.ok && stored.value?.inviteId).toBe('inv-1');
    expect(stored.ok && stored.value?.inviteEmail).toBe(INVITE_EMAIL);
    // Invite still consumed (single-use holds).
    const inv = await invites.findByJti('inv-1');
    expect(inv.ok && inv.value?.status).toBe('consumed');
  });

  it('rejects an expired invite (410)', async () => {
    invites.seed([
      buildRegistrationInvite({ jti: 'inv-1', parentOrgId: ORG_ID, email: INVITE_EMAIL }),
    ]);
    const { token } = await mintInviteToken({
      jti: 'inv-1',
      org: ORG_ID,
      email: INVITE_EMAIL,
      ttlSec: -1,
    });
    const res = await post({ ...validBody, invite: token });
    expect(res.statusCode).toBe(410);
    expect((res.json() as { error: { code: string } }).error.code).toBe('INVITE_EXPIRED');
  });

  it('rejects a tampered/invalid token (400)', async () => {
    const token = await seedInviteAndToken();
    const parts = token.split('.');
    const tampered = `${parts[0]}.${parts[1]}.${'A'.repeat(parts[2]!.length)}`;
    const res = await post({ ...validBody, invite: tampered });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('INVITE_INVALID');
  });

  it('rejects an invite whose row is no longer pending (409)', async () => {
    const token = await seedInviteAndToken({ status: 'revoked' });
    const res = await post({ ...validBody, invite: token });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('INVITE_ALREADY_USED');
  });

  it('rejects when the claim org is not active (409)', async () => {
    orgStore.seed([
      buildOrganisation({ id: ORG_ID, slug: 'o', status: 'inactive', ownerEmail: 'owner@o.org' }),
    ]);
    const token = await seedInviteAndToken();
    const res = await post({ ...validBody, invite: token });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('TARGET_ORG_INACTIVE');
  });

  it('does not burn the invite when a downstream check fails (H4)', async () => {
    // Seed a conflicting phone so the submit fails on the phone pre-check —
    // after the invite validations but before any provisioning. The invite must
    // stay pending so the coordinator can retry, not lose their one-time link.
    userStore.seed([
      buildCoordinator({
        contactPhone: '+919876543210',
        contactEmail: 'other@x.org',
        contact: { name: 'X', phone: '+919876543210', email: 'other@x.org' },
      }),
    ]);
    const token = await seedInviteAndToken();
    const res = await post({ ...validBody, invite: token });
    expect(res.statusCode).toBe(409);
    const inv = await invites.findByJti('inv-1');
    expect(inv.ok && inv.value?.status).toBe('pending');
  });

  it('a double-submit with the same invite loses the CAS on the second call', async () => {
    const token = await seedInviteAndToken();
    const first = await post({ ...validBody, invite: token });
    expect(first.statusCode).toBe(201);
    const second = await post({ ...validBody, invite: token });
    // Second attempt: invite already consumed → INVITE_ALREADY_USED (not a
    // double-create). (The email is also now registered, but the invite guard
    // fires first.)
    expect(second.statusCode).toBe(409);
    expect((second.json() as { error: { code: string } }).error.code).toBe('INVITE_ALREADY_USED');
  });

  // The volume bound #700 exists for (#718 review). Sequential submits only
  // prove the invite is no longer pending on the second call; the hole was
  // CONCURRENT submits, which all passed a read-only pre-check and each created
  // a registration. Distinct emails/phones on purpose: the unique constraints
  // are what the old code leaned on, and #701 leaves the invited email
  // non-enforcing, so an attacker is free to vary both.
  it('bounds CONCURRENT submits on one invite to a single registration', async () => {
    const token = await seedInviteAndToken();
    const bodyFor = (n: number) => ({
      ...validBody,
      name: `TRRAIN ${n}`,
      contact: { name: `Person ${n}`, phone: `+91987654321${n}`, email: `p${n}@x.org` },
      invite: token,
    });
    const rs = await Promise.all([1, 2, 3, 4, 5].map((n) => post(bodyFor(n))));
    expect(rs.filter((r) => r.statusCode === 201)).toHaveLength(1);
    // Every loser is authoritatively rejected, not silently allowed through.
    const losers = rs.filter((r) => r.statusCode !== 201);
    expect(losers).toHaveLength(4);
    for (const r of losers) {
      expect(r.statusCode).toBe(409);
      expect((r.json() as { error: { code: string } }).error.code).toBe('INVITE_ALREADY_USED');
    }
    // Only the winner's row exists — the other four created nothing.
    const created = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => userStore.findByContactEmail(`p${n}@x.org`)),
    );
    expect(created.filter((r) => r.ok && r.value !== null)).toHaveLength(1);
    const inv = await invites.findByJti('inv-1');
    expect(inv.ok && inv.value?.status).toBe('consumed');
  });

  it('releases the claim when provisioning fails, so the invite stays usable (H4)', async () => {
    const token = await seedInviteAndToken();
    // Occupy the phone so the submit fails AFTER the invite has been claimed.
    userStore.seed([
      buildCoordinator({
        contact: { name: 'Other', phone: validBody.contact.phone, email: 'other@x.org' },
      }),
    ]);
    const res = await post({ ...validBody, invite: token });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('PHONE_EXISTS');
    // Compensated back to pending — the coordinator's one-time link survives.
    const inv = await invites.findByJti('inv-1');
    expect(inv.ok && inv.value?.status).toBe('pending');
    expect(inv.ok && inv.value?.consumedAt).toBeNull();
    // ...and it still works once the collision is gone.
    userStore.reset();
    orgStore.seed([
      buildOrganisation({ id: ORG_ID, slug: 'o', status: 'active', ownerEmail: 'owner@o.org' }),
    ]);
    const retry = await post({ ...validBody, invite: token });
    expect(retry.statusCode).toBe(201);
  });
});
