// Org registration + dropdown routes (always registered since 0028).

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import {
  OrganisationStoreFake,
  buildOrganisation,
  buildDefaultOrg,
  _setOrganisationStore,
  OrganisationStoreBase,
  type Organisation,
  type CreateOrgInput,
  type OrgStoreResult,
} from '../services/organisation-store/index.js';
import { IdpAdminFake, _setIdpAdmin } from '../services/idp-admin/index.js';
import { UserStoreFake, buildCoordinator, _setUserStore } from '../services/user-store/index.js';
import { FakeMailer, _setMailer } from '@aggregator-dpg/mailer';
import { _resetTokenKey } from '../services/approval-token.js';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';
import { ConsentLedgerFake } from '@aggregator-dpg/consent-ledger/testing';
import { _setConsentLedger } from '../services/consent-ledger/index.js';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import { _setSubmitRateChecker } from '../services/submit-rate.js';
import { _setOrgInviteResendRateChecker } from '../services/org-invite-resend-rate.js';
import type * as ConfigLoaderFs from '@aggregator-dpg/config-loader/fs';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import { _setNetworkConfig } from '../services/network-config.js';
import { _resetOrgSchemaValidator } from '../services/org-schema-validator.js';

const { loadConsentConfigMock } = vi.hoisted(() => ({ loadConsentConfigMock: vi.fn() }));
vi.mock('@aggregator-dpg/config-loader/fs', async (importOriginal) => {
  const actual = await importOriginal<typeof ConfigLoaderFs>();
  return { ...actual, loadConsentConfig: loadConsentConfigMock };
});

const SERVICE_BEARER = 'service-token';
const AUTH_HEADER = { authorization: `Bearer ${SERVICE_BEARER}` };

describe('aggregator-orgs routes', () => {
  let app: FastifyInstance;
  let orgStore: OrganisationStoreFake;
  let idp: IdpAdminFake;
  let mailer: FakeMailer;
  let consentLedger: ConsentLedgerFake;
  let userStore: UserStoreFake;

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
    consentLedger = new ConsentLedgerFake();

    // Permissive by default, NOT `null`. `null` restores the Redis-backed
    // limiter, whose bucket is keyed `ip|email` — constant across this file —
    // so submits past the window cap 429 and which tests fail depends on the
    // wall clock. Cases that assert throttling install their own denier.
    _setSubmitRateChecker(async () => ({ allowed: true, retryAfterSeconds: 0 }));
    // Allow by default; the throttle cases override per-test.
    _setOrgInviteResendRateChecker(async () => ({ allowed: true, retryAfterSeconds: 0 }));
    loadConsentConfigMock.mockReset();
    const actualLoader = await vi.importActual<typeof ConfigLoaderFs>(
      '@aggregator-dpg/config-loader/fs',
    );
    loadConsentConfigMock.mockImplementation(actualLoader.loadConsentConfig);

    userStore = new UserStoreFake();
    _setUserStore(userStore);
    _setOrganisationStore(orgStore);
    _setNetworkConfig(buildBlueDotConfig());
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

  // A test may switch the deployment's network/brand; always switch it back.
  afterEach(() => {
    vi.unstubAllEnvs();
    _resetOrgSchemaValidator();
  });

  afterAll(async () => {
    await app?.close();
    _setOrganisationStore(null);
    _setIdpAdmin(null);
    _setMailer(null);
    _setConsentLedger(null);
    _setAccessTokenVerifier(null);
    _setSubmitRateChecker(null);
    _setOrgInviteResendRateChecker(null);
    _setNetworkConfig(null);
  });

  const orgBody = {
    display_name: 'Enable India',
    state: 'Karnataka',
    owner: { name: 'Ravi Kumar', email: 'ravi@enable.org', phone: '+919876500000' },
    consent: { value: true, given_at: '2026-01-15T10:00:00Z', valid_till: '2099-01-15T10:00:00Z' },
  };

  describe('one person per email/phone across coordinators and org owners (contact, 0025)', () => {
    it('409 USER_EXISTS before any write when a coordinator holds the owner email', async () => {
      userStore.seed([
        buildCoordinator({
          contact: { name: 'Ravi', email: 'ravi@enable.org', phone: '+919999900000' },
        }),
      ]);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/orgs/create',
        headers: AUTH_HEADER,
        payload: orgBody,
      });
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: { code: string } }).error.code).toBe('USER_EXISTS');
      // Nothing half-provisioned: no org row, no KC group, no KC user.
      const orgs = await orgStore.listPending();
      expect(orgs.ok && orgs.value).toEqual([]);
      expect(idp.getGroup('grp-1')).toBeUndefined();
    });

    it('409 PHONE_EXISTS when a coordinator holds the owner phone', async () => {
      userStore.seed([
        buildCoordinator({
          contact: { name: 'Someone', email: 'someone@else.org', phone: '+919876500000' },
        }),
      ]);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/orgs/create',
        headers: AUTH_HEADER,
        payload: orgBody,
      });
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: { code: string } }).error.code).toBe('PHONE_EXISTS');
    });

    it("409 PHONE_EXISTS when another org's owner holds the phone", async () => {
      orgStore.seed([
        buildOrganisation({
          id: 'o-other',
          slug: 'other-org',
          displayName: 'Other Org',
          ownerEmail: 'boss@other.org',
          ownerPhone: '+919876500000',
          status: 'active',
        }),
      ]);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/orgs/create',
        headers: AUTH_HEADER,
        payload: orgBody,
      });
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: { code: string } }).error.code).toBe('PHONE_EXISTS');
    });

    it('persists the owner name on create', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/orgs/create',
        headers: AUTH_HEADER,
        payload: orgBody,
      });
      expect(res.statusCode).toBe(201);
      const created = await orgStore.findByOwnerEmail('ravi@enable.org');
      expect(created.ok && created.value?.ownerName).toBe('Ravi Kumar');
    });
  });

  it('creates a pending org + mirrored group + disabled owner, emails the network admin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: orgBody,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { org_id: string; status: string };
    expect(body.status).toBe('pending');
    const stored = await orgStore.findById(body.org_id);
    expect(stored.ok && stored.value?.status).toBe('pending');
    expect(stored.ok && stored.value?.kcGroupId).toBeTruthy();
    // Mirrored group carries the human org name as an attribute (name is slug-based).
    const groupId = stored.ok ? stored.value?.kcGroupId : undefined;
    const group = groupId ? idp.getGroup(groupId) : undefined;
    expect(group?.attributes?.['display_name']).toBe('Enable India');
    expect(stored.ok && stored.value?.ownerKcSub).toBeTruthy();
    // Owner KC user created disabled.
    const owner = await idp.findByEmail('ravi@enable.org');
    expect(owner.ok && owner.value?.enabled).toBe(false);
    // A review email went to the network admin.
    expect(mailer.outbox.length).toBe(1);
    expect(mailer.outbox[0]?.to).toContain('reviewer@bluedots.local');

    // Consent ledger should have one row for the org
    const ledgerRows = consentLedger.list();
    expect(ledgerRows).toHaveLength(1);
    const consentRow = ledgerRows[0];
    expect(consentRow?.subjectType).toBe('organisation');
    expect(consentRow?.subjectId).toBe(body.org_id);
    expect(consentRow?.termsVersion).toBeGreaterThanOrEqual(1);
    expect(consentRow?.privacyVersion).toBeGreaterThanOrEqual(1);
    expect(consentRow?.source).toBe('registration');
    // network/brand must come from AGGREGATOR_NETWORK/AGGREGATOR_BRAND so the
    // recorded version matches what the web layer displayed.
    expect(consentRow?.network).toBe('blue_dot'); // default when AGGREGATOR_NETWORK unset
    expect(consentRow?.brand).toBeNull(); // default when AGGREGATOR_BRAND unset
  });

  // The schema-driven fields are per-network: each deployment's
  // org-registration JSON Schema owns its own closed set for
  // `organisation_type` (UP-GZB educational/non_educational, ALIMCO
  // ngo/government_entity/…) and the form validates the answer against it.
  // A zod enum here pinned one network's list and rejected every other
  // network's valid form with a 400, so the value must round-trip as given.
  it('accepts a network-specific organisation_type and stores the schema-driven fields', async () => {
    // A brand schema that declares `organisation_type` (purple_dot / alimco).
    vi.stubEnv('AGGREGATOR_NETWORK', 'purple_dot');
    vi.stubEnv('AGGREGATOR_BRAND', 'alimco');
    _resetOrgSchemaValidator();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: {
        ...orgBody,
        aggregator_type: ['seeker'],
        organisation_type: 'ngo',
        website: 'https://enable.org',
      },
    });
    expect(res.statusCode).toBe(201);
    const { org_id } = res.json() as { org_id: string };
    const stored = await orgStore.findById(org_id);
    const profile = (stored.ok ? stored.value?.profile : undefined) as
      Record<string, unknown> | undefined;
    expect(profile?.['organisation_type']).toBe('ngo');
    expect(profile?.['aggregator_type']).toEqual(['seeker']);
    expect(profile?.['website']).toBe('https://enable.org');
  });

  it('stores the default schema fields in profile, GSTIN upper-cased', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: {
        ...orgBody,
        website: 'https://enable.org',
        gst_number: '29abcde1234f1zw',
        domains: ['seeker'],
        // Not in the default schema: dropped, not stored.
        organisation_type: 'ngo',
      },
    });
    expect(res.statusCode).toBe(201);
    const stored = await orgStore.findById((res.json() as { org_id: string }).org_id);
    const profile = stored.ok ? stored.value?.profile : undefined;
    expect(profile).toMatchObject({
      website: 'https://enable.org',
      gst_number: '29ABCDE1234F1ZW',
      domains: ['seeker'],
    });
    expect(profile?.['organisation_type']).toBeUndefined();
  });

  it('refuses a bad schema field with field_errors, creating nothing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: {
        ...orgBody,
        website: 'http://enable.org',
        gst_number: '29ABCDE1234F1Z5',
        domains: ['astronaut'],
      },
    });
    expect(res.statusCode).toBe(400);
    const error = (res.json() as { error: { code: string; fields: { field_errors: object } } })
      .error;
    expect(error.code).toBe('SCHEMA_VALIDATION');
    expect(Object.keys(error.fields.field_errors).sort()).toEqual([
      'domains',
      'gst_number',
      'website',
    ]);
    expect((error.fields.field_errors as Record<string, string>)['website']).toBe(
      'Please enter a website starting with https://',
    );
  });

  it('records org consent in the ledger on successful registration', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: orgBody,
    });
    expect(res.statusCode).toBe(201);
    const { org_id } = res.json() as { org_id: string };

    const ledgerRows = consentLedger.list();
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]?.subjectType).toBe('organisation');
    expect(ledgerRows[0]?.subjectId).toBe(org_id);
  });

  it('fails org registration (fail-closed) when the consent ledger write fails', async () => {
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
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: { ...orgBody, owner: { ...orgBody.owner, email: 'ledger-fail@enable.org' } },
    });
    // Fail-closed: the org path has no fallback, so a consent-write failure
    // rolls the registration back rather than returning 201.
    expect(res.statusCode).toBe(500);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('CONSENT_WRITE_FAILED');
    // One transaction (0029): no org and no owner remain, and Keycloak was
    // never reached.
    const owner = await orgStore.findByOwnerEmail('ledger-fail@enable.org');
    expect(owner.ok && owner.value).toBeNull();
    const kc = await idp.findByEmail('ledger-fail@enable.org');
    expect(kc.ok && kc.value).toBeNull();
  });

  it.each([
    // A month from now: always inside the window, whatever the run date.
    ['a date within the window', new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(), false],
    ['a date beyond the ceiling', '2099-01-01T00:00:00Z', true],
    ['an unparseable value', 'not-a-date', true],
  ])(
    'stores the org consent valid_till on the ledger row: %s',
    async (_label, validTill, clamped) => {
      const email = `till-${validTill.slice(0, 4)}@enable.org`;
      const res = await app.inject({
        method: 'POST',
        url: '/v1/orgs/create',
        headers: AUTH_HEADER,
        payload: {
          ...orgBody,
          display_name: `Till ${validTill.slice(0, 7)}`,
          owner: {
            ...orgBody.owner,
            email,
            phone: `+9198765${String(validTill.length).padStart(5, '0')}`,
          },
          consent: { ...orgBody.consent, valid_till: validTill },
        },
      });
      expect(res.statusCode).toBe(201);
      const { org_id } = res.json() as { org_id: string };
      const row = consentLedger.list().find((r) => r.subjectId === org_id);
      expect(row?.subjectType).toBe('organisation');
      const stored = row?.validTill?.getTime() ?? 0;
      if (clamped) {
        const ceiling = Date.now() + 5 * 365 * 24 * 60 * 60 * 1000;
        expect(Math.abs(stored - ceiling)).toBeLessThan(60_000);
      } else {
        expect(stored).toBe(new Date(validTill).getTime());
      }
    },
  );

  it('400 SCHEMA_VALIDATION for an org consent that is already expired', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: {
        ...orgBody,
        owner: { ...orgBody.owner, email: 'expired@enable.org' },
        consent: { ...orgBody.consent, valid_till: '2020-01-01T00:00:00Z' },
      },
    });
    expect(res.statusCode).toBe(400);
    const owner = await orgStore.findByOwnerEmail('expired@enable.org');
    expect(owner.ok && owner.value).toBeNull();
  });

  it('GET /v1/orgs lists only active orgs', async () => {
    orgStore.seed([
      buildOrganisation({ id: 'o-active', slug: 'a', displayName: 'A', status: 'active' }),
      buildOrganisation({ id: 'o-pending', slug: 'b', displayName: 'B', status: 'pending' }),
    ]);
    const res = await app.inject({ method: 'GET', url: '/v1/orgs', headers: AUTH_HEADER });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { orgs: { id: string; slug: string; display_name: string }[] };
    expect(body.orgs.map((o) => o.slug)).toEqual(['a']);
    expect(body.orgs[0]?.display_name).toBe('A');
  });

  it('GET /v1/orgs sorts by name and hides Default once a real org is active (0028)', async () => {
    orgStore.seed([
      buildDefaultOrg(),
      buildOrganisation({ id: 'o-z', slug: 'z', displayName: 'zeta Org', status: 'active' }),
      buildOrganisation({ id: 'o-a', slug: 'a', displayName: 'Alpha Org', status: 'active' }),
    ]);
    const res = await app.inject({ method: 'GET', url: '/v1/orgs', headers: AUTH_HEADER });
    const body = res.json() as { orgs: { slug: string }[] };
    expect(body.orgs.map((o) => o.slug)).toEqual(['a', 'z']);
  });

  it('GET /v1/orgs lists the Default org while it is the only active org', async () => {
    orgStore.seed([buildDefaultOrg()]);
    const res = await app.inject({ method: 'GET', url: '/v1/orgs', headers: AUTH_HEADER });
    const body = res.json() as { orgs: { slug: string; display_name: string }[] };
    expect(body.orgs).toEqual([
      { id: buildDefaultOrg().id, slug: 'default', display_name: 'Default' },
    ]);
  });

  describe('parent org (org nesting)', () => {
    const ROOT_ID = '00000000-0000-4000-8000-0000000000f0';
    const STATE_ID = '00000000-0000-4000-8000-0000000000f1';
    const root = buildOrganisation({
      id: ROOT_ID,
      slug: 'network',
      displayName: 'Blue Dots Network',
      ownerEmail: 'nf@test.local',
      status: 'active',
      depth: 0,
    });
    const state = buildOrganisation({
      id: STATE_ID,
      slug: 'state',
      displayName: 'State Org',
      ownerEmail: 'state@test.local',
      status: 'active',
      parentId: ROOT_ID,
      knownAs: 'state',
    });
    const create = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/v1/orgs/create', headers: AUTH_HEADER, payload });
    const storedParent = async (orgId: string) => {
      const r = await orgStore.findById(orgId);
      return r.ok ? r.value?.parentId : undefined;
    };

    const setHierarchy = (hierarchy: {
      max_depth: number;
      max_children?: number;
      max_total_orgs: number;
    }) => {
      const base = buildBlueDotConfig();
      _setNetworkConfig(
        buildBlueDotConfig({
          aggregator: {
            ...base.aggregator,
            organisation: { hierarchy },
          },
        }),
      );
    };
    const errorOf = (res: { json: () => unknown }) =>
      (res.json() as { error: { code: string; fields?: Record<string, unknown> } }).error;
    const getParents = async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/orgs/parents',
        headers: AUTH_HEADER,
      });
      expect(res.statusCode).toBe(200);
      return res.json() as { accepting: boolean; parents: { id: string; name: string }[] };
    };
    const district = buildOrganisation({
      id: '00000000-0000-4000-8000-0000000000f5',
      slug: 'district-a',
      displayName: 'District A',
      ownerEmail: 'district-a@test.local',
      status: 'active',
      parentId: STATE_ID,
      knownAs: 'district',
      depth: 2,
    });

    beforeEach(() => {
      orgStore.seedRoot(root);
      orgStore.seed([state]);
      orgStore.seedKnownAsValues(ROOT_ID, [{ key: 'state', name: 'State', default: true }]);
      orgStore.seedKnownAsValues(STATE_ID, [
        { key: 'block', name: 'Block' },
        { key: 'district', name: 'District', default: true },
      ]);
      setHierarchy({ max_depth: 3, max_total_orgs: 50 });
    });

    it('puts the org under the root when parent_id is omitted, at depth 1', async () => {
      const res = await create(orgBody);
      expect(res.statusCode).toBe(201);
      const orgId = (res.json() as { org_id: string }).org_id;
      expect(await storedParent(orgId)).toBe(ROOT_ID);
      const stored = await orgStore.findById(orgId);
      expect(stored.ok && stored.value?.knownAs).toBe('state');
    });

    it('gives the system value under a parent with no default', async () => {
      const aggId = '00000000-0000-4000-8000-0000000000f3';
      orgStore.seed([
        buildOrganisation({
          id: aggId,
          slug: 'agg',
          displayName: 'Agg Org',
          ownerEmail: 'agg@test.local',
          status: 'active',
          knownAs: 'aggregator',
          depth: 2,
        }),
      ]);
      const res = await create({ ...orgBody, parent_id: aggId });
      expect(res.statusCode).toBe(201);
      const stored = await orgStore.findById((res.json() as { org_id: string }).org_id);
      expect(stored.ok && stored.value?.knownAs).toBe('aggregator');
    });

    it('puts the org under the requested parent, keeps parent_id out of the profile, and names the parent in the review email', async () => {
      const res = await create({ ...orgBody, parent_id: STATE_ID });
      expect(res.statusCode).toBe(201);
      const orgId = (res.json() as { org_id: string }).org_id;
      expect(await storedParent(orgId)).toBe(STATE_ID);
      const stored = await orgStore.findById(orgId);
      expect(stored.ok && stored.value?.profile).not.toHaveProperty('parent_id');
      // The parent's default value.
      expect(stored.ok && stored.value?.knownAs).toBe('district');
      expect(mailer.outbox[0]?.text).toContain('Parent:      State Org');
    });

    it("sends the review to the parent org's owner, not the network admin", async () => {
      const res = await create({ ...orgBody, parent_id: STATE_ID });
      expect(res.statusCode).toBe(201);
      expect(mailer.outbox).toHaveLength(1);
      expect(mailer.outbox[0]?.to).toEqual([state.ownerEmail]);
      expect(mailer.outbox[0]?.to).not.toContain('reviewer@bluedots.local');
    });

    it('sends the review for a top-level org to the network admin', async () => {
      const res = await create(orgBody);
      expect(res.statusCode).toBe(201);
      expect(mailer.outbox[0]?.to).toContain('reviewer@bluedots.local');
    });

    it.each([
      ['an unknown org', '00000000-0000-4000-8000-0000000000ff'],
      ['the Default org', buildDefaultOrg().id],
    ])('400s with fields.parent_id for %s and creates nothing', async (_label, parentId) => {
      orgStore.seed([buildDefaultOrg()]);
      const createGroup = vi.spyOn(idp, 'createGroup');
      const res = await create({ ...orgBody, parent_id: parentId });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { error: { fields: Record<string, string> } };
      expect(body.error.fields).toMatchObject({ parent_id: 'invalid' });
      const owner = await orgStore.findByOwnerEmail(orgBody.owner.email);
      expect(owner.ok && owner.value).toBeNull();
      expect(createGroup).not.toHaveBeenCalled();
    });

    it('400s on a parent_id that is not a uuid', async () => {
      const res = await create({ ...orgBody, parent_id: 'state' });
      expect(res.statusCode).toBe(400);
    });

    it('creates under a nested parent with no list as aggregator', async () => {
      orgStore.seed([district]);
      const res = await create({ ...orgBody, parent_id: district.id });
      expect(res.statusCode).toBe(201);
      const stored = await orgStore.findById((res.json() as { org_id: string }).org_id);
      expect(stored.ok && stored.value).toMatchObject({
        parentId: district.id,
        depth: 3,
        knownAs: 'aggregator',
      });
    });

    it('409 ORG_DEPTH_LIMIT with fields.parent_id when the parent is at max_depth', async () => {
      setHierarchy({ max_depth: 1, max_total_orgs: 50 });
      const createGroup = vi.spyOn(idp, 'createGroup');
      const res = await create({ ...orgBody, parent_id: STATE_ID });
      expect(res.statusCode).toBe(409);
      expect(errorOf(res)).toMatchObject({
        code: 'ORG_DEPTH_LIMIT',
        fields: { parent_id: STATE_ID },
      });
      expect(createGroup).not.toHaveBeenCalled();
    });

    it('409 ORG_CHILD_LIMIT with fields.parent_id when the parent is full', async () => {
      setHierarchy({ max_depth: 3, max_children: 1, max_total_orgs: 50 });
      orgStore.seed([district]);
      const res = await create({ ...orgBody, parent_id: STATE_ID });
      expect(res.statusCode).toBe(409);
      expect(errorOf(res)).toMatchObject({
        code: 'ORG_CHILD_LIMIT',
        fields: { parent_id: STATE_ID },
      });
    });

    it('409 ORG_CHILD_LIMIT with a null parent_id when the root is full and none was given', async () => {
      setHierarchy({ max_depth: 3, max_children: 1, max_total_orgs: 50 });
      const res = await create(orgBody);
      expect(res.statusCode).toBe(409);
      expect(errorOf(res)).toMatchObject({
        code: 'ORG_CHILD_LIMIT',
        fields: { parent_id: null },
      });
    });

    it('409 ORG_TOTAL_LIMIT when the instance holds max_total_orgs', async () => {
      setHierarchy({ max_depth: 3, max_total_orgs: 1 });
      const res = await create(orgBody);
      expect(res.statusCode).toBe(409);
      expect(errorOf(res).code).toBe('ORG_TOTAL_LIMIT');
    });

    it('409 ORG_CHILD_LIMIT when a rejected org re-registers under a now-full parent', async () => {
      setHierarchy({ max_depth: 3, max_children: 1, max_total_orgs: 50 });
      orgStore.seed([
        district,
        buildOrganisation({
          id: 'o-rejected',
          slug: 'rejected',
          displayName: 'Rejected Org',
          ownerEmail: orgBody.owner.email,
          status: 'inactive',
          parentId: STATE_ID,
          depth: 2,
          rejectedAt: new Date(Date.now() - 13 * 60 * 60 * 1000),
        }),
      ]);
      const res = await create({ ...orgBody, parent_id: STATE_ID });
      expect(res.statusCode).toBe(409);
      expect(errorOf(res)).toMatchObject({
        code: 'ORG_CHILD_LIMIT',
        fields: { parent_id: STATE_ID },
      });
      const stored = await orgStore.findById('o-rejected');
      expect(stored.ok && stored.value?.status).toBe('inactive');
      expect(mailer.outbox).toHaveLength(0);
    });

    const rejected = (over: Partial<Organisation> = {}) =>
      buildOrganisation({
        id: 'o-rejected',
        slug: 'rejected',
        displayName: 'Rejected Org',
        ownerEmail: orgBody.owner.email,
        status: 'inactive',
        rejectedAt: new Date(Date.now() - 13 * 60 * 60 * 1000),
        ...over,
      });

    it('revives a rejected org under the submitted parent, still pending', async () => {
      orgStore.seed([rejected({ parentId: ROOT_ID, depth: 1, knownAs: 'state' })]);
      const res = await create({ ...orgBody, parent_id: STATE_ID });
      expect(res.statusCode).toBe(200);
      const stored = await orgStore.findById('o-rejected');
      expect(stored.ok && stored.value).toMatchObject({
        status: 'pending',
        parentId: STATE_ID,
        depth: 2,
        knownAs: 'district',
        displayName: 'Rejected Org',
      });
    });

    it('names the new parent in the review email after a revive', async () => {
      orgStore.seed([rejected({ parentId: ROOT_ID, parentName: 'Blue Dots Network', depth: 1 })]);
      const res = await create({ ...orgBody, parent_id: STATE_ID });
      expect(res.statusCode).toBe(200);
      const review = mailer.outbox.at(-1);
      expect(review?.text).toContain('Parent:      State Org');
      expect(review?.text).not.toContain('Blue Dots Network');
    });

    it('revives a rejected org under the root when parent_id is omitted', async () => {
      orgStore.seed([district, rejected({ parentId: district.id, depth: 3 })]);
      const res = await create(orgBody);
      expect(res.statusCode).toBe(200);
      const stored = await orgStore.findById('o-rejected');
      expect(stored.ok && stored.value).toMatchObject({
        status: 'pending',
        parentId: ROOT_ID,
        depth: 1,
      });
    });

    it('409 CONFLICT when the rejected org changes before it is revived', async () => {
      orgStore.seed([
        buildOrganisation({
          id: 'o-raced',
          ownerEmail: orgBody.owner.email,
          status: 'inactive',
          rejectedAt: new Date(Date.now() - 13 * 60 * 60 * 1000),
        }),
      ]);
      vi.spyOn(orgStore, 'revive').mockResolvedValueOnce({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'o-raced' },
      });
      const res = await create(orgBody);
      expect(res.statusCode).toBe(409);
      expect(errorOf(res).code).toBe('CONFLICT');
    });

    it('GET /v1/orgs/parents lists only the root with max_depth 1', async () => {
      setHierarchy({ max_depth: 1, max_total_orgs: 50 });
      const body = await getParents();
      expect(body.accepting).toBe(true);
      expect(body.parents.map((p) => p.id)).toEqual([ROOT_ID]);
    });

    it('GET /v1/orgs/parents leaves out full parents and parents at max_depth', async () => {
      setHierarchy({ max_depth: 2, max_children: 1, max_total_orgs: 50 });
      const other = buildOrganisation({
        id: '00000000-0000-4000-8000-0000000000f6',
        slug: 'other',
        displayName: 'Other Org',
        ownerEmail: 'other@test.local',
        status: 'active',
        parentId: ROOT_ID,
      });
      // The root holds State and Other; State holds District A (at max_depth).
      orgStore.seed([other, district]);
      const body = await getParents();
      expect(body.parents.map((p) => p.name)).toEqual(['Other Org']);
      expect(body.accepting).toBe(true);
    });

    it('GET /v1/orgs/parents is not accepting when no parent can take a child', async () => {
      setHierarchy({ max_depth: 1, max_children: 1, max_total_orgs: 50 });
      const body = await getParents();
      expect(body).toEqual({ accepting: false, parents: [] });
    });

    it('GET /v1/orgs/parents is not accepting at max_total_orgs', async () => {
      setHierarchy({ max_depth: 3, max_total_orgs: 1 });
      const body = await getParents();
      expect(body.accepting).toBe(false);
      expect(body.parents.length).toBeGreaterThan(0);
    });

    it('GET /v1/orgs/parents lists the root first, then active non-Default orgs with their names', async () => {
      orgStore.seed([
        buildDefaultOrg(),
        buildOrganisation({ id: 'o-p', slug: 'p', displayName: 'Pending', status: 'pending' }),
      ]);
      const res = await app.inject({
        method: 'GET',
        url: '/v1/orgs/parents',
        headers: AUTH_HEADER,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        accepting: true,
        parents: [
          {
            id: ROOT_ID,
            name: 'Blue Dots Network',
            is_root: true,
            known_as_name: null,
            child_known_as_name: 'State',
          },
          {
            id: STATE_ID,
            name: 'State Org',
            is_root: false,
            known_as_name: 'State',
            child_known_as_name: 'District',
          },
        ],
      });
    });

    it('GET /v1/orgs/parents names each org by its known_as, with the value a child would get', async () => {
      orgStore.seed([
        buildOrganisation({
          id: '00000000-0000-4000-8000-0000000000f2',
          slug: 'district',
          displayName: 'District Org',
          ownerEmail: 'district@test.local',
          status: 'active',
          parentId: STATE_ID,
          knownAs: 'district',
          depth: 2,
        }),
        buildOrganisation({
          id: '00000000-0000-4000-8000-0000000000f4',
          slug: 'stale',
          displayName: 'Stale Org',
          ownerEmail: 'stale@test.local',
          status: 'active',
          parentId: STATE_ID,
          knownAs: 'retired_key',
          depth: 2,
        }),
      ]);
      orgStore.seedKnownAsValues('00000000-0000-4000-8000-0000000000f2', [
        { key: 'ward', name: 'Ward' },
      ]);
      const res = await app.inject({
        method: 'GET',
        url: '/v1/orgs/parents',
        headers: AUTH_HEADER,
      });
      const parents = (
        res.json() as {
          parents: {
            name: string;
            known_as_name: string | null;
            child_known_as_name: string | null;
          }[];
        }
      ).parents;
      expect(parents.find((p) => p.name === 'District Org')).toMatchObject({
        known_as_name: 'District',
        child_known_as_name: 'Aggregator',
      });
      // A key the parent's list does not have reads as Aggregator.
      expect(parents.find((p) => p.name === 'Stale Org')).toMatchObject({
        known_as_name: 'Aggregator',
        child_known_as_name: 'Aggregator',
      });
    });

    it('GET /v1/orgs/parents 503s when the store is down', async () => {
      vi.spyOn(orgStore, 'listActive').mockResolvedValueOnce({
        ok: false,
        error: { code: 'DB_UNAVAILABLE', message: 'down' },
      });
      const res = await app.inject({
        method: 'GET',
        url: '/v1/orgs/parents',
        headers: AUTH_HEADER,
      });
      expect(res.statusCode).toBe(503);
    });

    it('GET /v1/orgs/parents 401s without a token', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/orgs/parents' });
      expect(res.statusCode).toBe(401);
    });
  });

  it("stores the form's website and address as the org's url and location (0028)", async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: {
        ...orgBody,
        website: 'https://enable.example',
        address: { streetAddress: '1 Main Rd', addressLocality: 'Bengaluru' },
        coordinates: [77.59, 12.97],
      },
    });
    expect(res.statusCode).toBe(201);
    const created = await orgStore.findById((res.json() as { org_id: string }).org_id);
    // The website is a schema field: it lives in `profile`, not a column.
    expect(created.ok && created.value?.profile['website']).toBe('https://enable.example');
    expect(created.ok && created.value?.locations).toEqual([
      {
        geo: { type: 'Point', coordinates: [77.59, 12.97] },
        address: {
          streetAddress: '1 Main Rd',
          addressLocality: 'Bengaluru',
          addressRegion: 'Karnataka',
        },
      },
    ]);
  });

  it("keeps the form's full address in profile, district included", async () => {
    const address = {
      streetAddress: '1 Main Rd',
      addressLocality: 'Bengaluru',
      addressDistrict: 'Bengaluru Urban',
      addressRegion: 'Karnataka',
      postalCode: '560001',
      addressCountry: 'IN',
    };
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: { ...orgBody, address, coordinates: [77.59, 12.97] },
    });
    expect(res.statusCode).toBe(201);
    const created = await orgStore.findById((res.json() as { org_id: string }).org_id);
    const profile = created.ok ? created.value?.profile : undefined;
    expect(profile?.['address']).toEqual(address);
    expect(profile?.['coordinates']).toEqual([77.59, 12.97]);
  });

  it('stores no address in profile when the form sends none', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: orgBody,
    });
    expect(res.statusCode).toBe(201);
    const created = await orgStore.findById((res.json() as { org_id: string }).org_id);
    expect(created.ok && created.value?.profile).not.toHaveProperty('address');
  });

  it('retries a colliding random slug instead of failing (review A11)', async () => {
    let calls = 0;
    const realCreate = orgStore.create.bind(orgStore);
    orgStore.create = async (input, rules) => {
      calls += 1;
      if (calls === 1) return { ok: false, error: { code: 'DUPLICATE_SLUG', message: 'taken' } };
      return realCreate(input, rules);
    };
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: orgBody,
    });
    expect(res.statusCode).toBe(201);
    expect(calls).toBe(2);
  });

  it('rejects org registration when consent.value is false (400/validation)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: { ...orgBody, consent: { ...orgBody.consent, value: false } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('re-mints the review link for a pending org on resubmit — no field overwrite (§7)', async () => {
    orgStore.seed([
      buildOrganisation({
        id: 'o-reclaim',
        slug: 'enable-india-abcd',
        displayName: 'Old Name',
        ownerEmail: 'ravi@enable.org',
        status: 'pending',
      }),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: orgBody, // display_name 'Enable India' — must be IGNORED
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { org_id: string; status: string };
    expect(body.org_id).toBe('o-reclaim');
    expect(body.status).toBe('pending');
    // On-file record is NOT overwritten (no takeover); link re-sent.
    const stored = await orgStore.findById('o-reclaim');
    expect(stored.ok && stored.value?.displayName).toBe('Old Name');
    expect(mailer.outbox.length).toBe(1);
  });

  it('returns 409 REGISTRATION_COOLING for a rejected org inside the cooling window', async () => {
    orgStore.seed([
      buildOrganisation({
        id: 'o-cooling',
        slug: 'enable-india-rej1',
        ownerEmail: 'ravi@enable.org',
        status: 'inactive',
        rejectedAt: new Date(), // just rejected → still cooling
      }),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: orgBody,
    });
    expect(res.statusCode).toBe(409);
    const err = res.json() as { error: { code: string; fields?: { retry_after?: string } } };
    expect(err.error.code).toBe('REGISTRATION_COOLING');
    expect(err.error.fields?.retry_after).toBeTruthy();
    const stored = await orgStore.findById('o-cooling');
    expect(stored.ok && stored.value?.status).toBe('inactive');
    expect(mailer.outbox.length).toBe(0);
  });

  it('revives a rejected org once the cooling window has elapsed', async () => {
    orgStore.seed([
      buildOrganisation({
        id: 'o-revive',
        slug: 'enable-india-rej2',
        displayName: 'Old Name',
        ownerEmail: 'ravi@enable.org',
        status: 'inactive',
        rejectedAt: new Date(Date.now() - 13 * 60 * 60 * 1000), // 13h ago > 12h default
      }),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: orgBody,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { org_id: string; status: string };
    expect(body.org_id).toBe('o-revive');
    expect(body.status).toBe('pending');
    const stored = await orgStore.findById('o-revive');
    if (stored.ok) {
      expect(stored.value?.status).toBe('pending');
      expect(stored.value?.rejectedAt).toBeNull();
      // No field overwrite on revive.
      expect(stored.value?.displayName).toBe('Old Name');
    }
    expect(mailer.outbox.length).toBe(1);
  });

  it('sends the owner a sign-in link when the org is already ACTIVE', async () => {
    orgStore.seed([
      buildOrganisation({
        id: 'o-active-owner',
        slug: 'enable-india-live',
        displayName: 'Old Name',
        ownerEmail: 'active-owner@enable.org',
        status: 'active',
      }),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: { ...orgBody, owner: { ...orgBody.owner, email: 'active-owner@enable.org' } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { org_id: string; status: string; message: string };
    expect(body.org_id).toBe('o-active-owner');
    expect(body.status).toBe('active');
    expect(body.message).toMatch(/already registered/i);
    // The invite link is the whole point of the mail.
    expect(mailer.outbox.length).toBe(1);
    expect(mailer.outbox[0]?.subject).toMatch(/already registered/i);
    // Phase 5: a console sign-in link, never a fresh grant.
    expect(mailer.outbox[0]?.html).toContain('/login');
    expect(mailer.outbox[0]?.html).not.toContain('grant=');
    // Nothing about the row changes — no takeover via an anonymous resubmit.
    const stored = await orgStore.findById('o-active-owner');
    expect(stored.ok && stored.value?.displayName).toBe('Old Name');
    expect(stored.ok && stored.value?.status).toBe('active');
  });

  it('throttles the invite resend per OWNER address and mints nothing', async () => {
    // Each admitted resend mints another independent 90-day grant, so the cap
    // has to be enforced before minting — not just before mailing.
    orgStore.seed([
      buildOrganisation({
        id: 'o-active-throttled',
        slug: 'enable-india-live6',
        ownerEmail: 'throttled@enable.org',
        status: 'active',
      }),
    ]);
    const seen: string[] = [];
    _setOrgInviteResendRateChecker(async (email) => {
      seen.push(email);
      return { allowed: false, retryAfterSeconds: 900 };
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: { ...orgBody, owner: { ...orgBody.owner, email: 'throttled@enable.org' } },
    });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('900');
    const err = res.json() as {
      error: { code: string; fields?: { retry_after_seconds?: number } };
    };
    expect(err.error.code).toBe('RATE_LIMITED');
    expect(err.error.fields?.retry_after_seconds).toBe(900);
    // No mail, and therefore no grant.
    expect(mailer.outbox.length).toBe(0);
    // Keyed on the STORED owner address, so a caller cannot pick a fresh bucket.
    expect(seen).toEqual(['throttled@enable.org']);
  });

  it('keys the resend bucket on the STORED address, not the submitted one', async () => {
    // The org form is anonymous. Keying on submitted input would let an
    // attacker rotate the payload email and get an unused bucket every time.
    orgStore.seed([
      buildOrganisation({
        id: 'o-active-keyed',
        slug: 'enable-india-live7',
        ownerEmail: 'stored-owner@enable.org',
        status: 'active',
      }),
    ]);
    const seen: string[] = [];
    _setOrgInviteResendRateChecker(async (email) => {
      seen.push(email);
      return { allowed: true, retryAfterSeconds: 0 };
    });
    await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: { ...orgBody, owner: { ...orgBody.owner, email: 'stored-owner@enable.org' } },
    });
    expect(seen).toEqual(['stored-owner@enable.org']);
  });

  it('mails the STORED owner address, never the resubmitted one', async () => {
    // The org form is anonymous. Honouring the submitted address would hand a
    // stranger a 90-day credential that mints coordinator invites for this org.
    orgStore.seed([
      buildOrganisation({
        id: 'o-active-hijack',
        slug: 'enable-india-live2',
        ownerEmail: 'real-owner@enable.org',
        status: 'active',
      }),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: { ...orgBody, owner: { ...orgBody.owner, email: 'real-owner@enable.org' } },
    });
    expect(res.statusCode).toBe(200);
    expect(mailer.outbox.length).toBe(1);
    expect(mailer.outbox[0]?.to).toContain('real-owner@enable.org');
  });

  it('still rejects a resubmit against a RETIRED org with OWNER_ALREADY_REGISTERED', async () => {
    // A dead org must never be handed a working credential.
    orgStore.seed([
      buildOrganisation({
        id: 'o-retired-owner',
        slug: 'enable-india-dead',
        ownerEmail: 'retired-owner@enable.org',
        status: 'retired',
      }),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: { ...orgBody, owner: { ...orgBody.owner, email: 'retired-owner@enable.org' } },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe('OWNER_ALREADY_REGISTERED');
    expect(mailer.outbox.length).toBe(0);
  });

  it('does not claim delivery when the invite mail fails', async () => {
    // The owner in this branch is one who never got the first email; telling
    // them a second is on its way when the send just failed leaves them
    // waiting instead of contacting support.
    orgStore.seed([
      buildOrganisation({
        id: 'o-active-nolie',
        slug: 'enable-india-live4',
        ownerEmail: 'active-nolie@enable.org',
        status: 'active',
      }),
    ]);
    mailer.failOnce({ code: 'TRANSPORT_FAILED', message: 'smtp down' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: { ...orgBody, owner: { ...orgBody.owner, email: 'active-nolie@enable.org' } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { mail_sent: boolean; message: string };
    expect(body.mail_sent).toBe(false);
    expect(body.message).toMatch(/could not be emailed/i);
    expect(body.message).not.toMatch(/has been sent/i);
  });

  it('reports mail_sent true on the happy path', async () => {
    orgStore.seed([
      buildOrganisation({
        id: 'o-active-sent',
        slug: 'enable-india-live5',
        ownerEmail: 'active-sent@enable.org',
        status: 'active',
      }),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: { ...orgBody, owner: { ...orgBody.owner, email: 'active-sent@enable.org' } },
    });
    expect((res.json() as { mail_sent: boolean }).mail_sent).toBe(true);
  });

  it('still answers 200 for an ACTIVE org when the invite mail cannot be delivered', async () => {
    // Soft-fail, matching the approval path: the org is live either way, so a
    // mail outage must not surface as a registration failure.
    orgStore.seed([
      buildOrganisation({
        id: 'o-active-mailfail',
        slug: 'enable-india-live3',
        ownerEmail: 'active-mailfail@enable.org',
        status: 'active',
      }),
    ]);
    mailer.failOnce({ code: 'TRANSPORT_FAILED', message: 'smtp down' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: { ...orgBody, owner: { ...orgBody.owner, email: 'active-mailfail@enable.org' } },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe('active');
  });

  it('rejects a second org with a case-insensitively matching name (ORG_NAME_TAKEN, 409)', async () => {
    // An existing active org already owns the name — a different owner submits
    // the same display_name (different case) and must be blocked.
    orgStore.seed([
      buildOrganisation({
        id: 'o-name-owner',
        slug: 'enable-india-live',
        displayName: 'Enable India',
        ownerEmail: 'someone-else@enable.org',
        status: 'active',
      }),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: { ...orgBody, display_name: 'enable india' },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('ORG_NAME_TAKEN');
  });

  it('maps a DUPLICATE_SLUG store error to ORG_SLUG_TAKEN (409)', async () => {
    // A store stub that always reports a slug collision on create.
    class DupSlugStore extends OrganisationStoreBase {
      async create(_i: CreateOrgInput): Promise<OrgStoreResult<Organisation>> {
        return { ok: false, error: { code: 'DUPLICATE_SLUG', message: 'taken' } };
      }
      async findById(): Promise<OrgStoreResult<Organisation | null>> {
        return { ok: true, value: null };
      }
      async findBySlug(): Promise<OrgStoreResult<Organisation | null>> {
        return { ok: true, value: null };
      }
      async findDefault(): Promise<OrgStoreResult<Organisation | null>> {
        return { ok: true, value: null };
      }
      async findRoot(): Promise<OrgStoreResult<Organisation | null>> {
        return { ok: true, value: null };
      }
      async ownerIsShared(): Promise<OrgStoreResult<boolean>> {
        return { ok: true, value: false };
      }
      async findByOwnerEmail(): Promise<OrgStoreResult<Organisation | null>> {
        return { ok: true, value: null };
      }
      async findByOwnerPhone(): Promise<OrgStoreResult<Organisation | null>> {
        return { ok: true, value: null };
      }
      async listActive(): Promise<OrgStoreResult<Organisation[]>> {
        return { ok: true, value: [] };
      }
      async listPending(): Promise<OrgStoreResult<Organisation[]>> {
        return { ok: true, value: [] };
      }
      async deleteById(): Promise<OrgStoreResult<void>> {
        return { ok: true, value: undefined };
      }
      async update(): Promise<OrgStoreResult<Organisation>> {
        return { ok: false, error: { code: 'NOT_FOUND', message: 'x' } };
      }
      async approve(): Promise<OrgStoreResult<Organisation | null>> {
        return { ok: true, value: null };
      }
      async reject(): Promise<OrgStoreResult<Organisation | null>> {
        return { ok: true, value: null };
      }
      async listOwnedBy(): Promise<OrgStoreResult<Organisation[]>> {
        return { ok: true, value: [] };
      }
      async descendantIds(): Promise<OrgStoreResult<string[]>> {
        return { ok: true, value: [] };
      }
      async childIds(): Promise<OrgStoreResult<string[]>> {
        return { ok: true, value: [] };
      }
      async setKnownAs(): Promise<OrgStoreResult<Organisation>> {
        return { ok: false, error: { code: 'NOT_FOUND', message: 'x' } };
      }
      async setKnownAsValues(): Promise<
        OrgStoreResult<{ org: Organisation; values: []; resetCount: number }>
      > {
        return { ok: false, error: { code: 'NOT_FOUND', message: 'x' } };
      }
      async knownAsValues(): Promise<OrgStoreResult<[]>> {
        return { ok: true, value: [] };
      }
      async defaultKnownAsNames(): Promise<OrgStoreResult<Record<string, string>>> {
        return { ok: true, value: {} };
      }
      async countStaleKnownAs(): Promise<OrgStoreResult<number>> {
        return { ok: true, value: 0 };
      }
      async search(): Promise<OrgStoreResult<{ rows: Organisation[]; nextCursor: null }>> {
        return { ok: true, value: { rows: [], nextCursor: null } };
      }
      async deleteIfPending(): Promise<OrgStoreResult<'not_pending'>> {
        return { ok: true, value: 'not_pending' };
      }
      async revive(): Promise<OrgStoreResult<Organisation>> {
        return { ok: false, error: { code: 'NOT_FOUND', message: 'x' } };
      }
      async move(): Promise<
        OrgStoreResult<{ org: Organisation; oldParentId: string | null; movedCount: number }>
      > {
        return { ok: false, error: { code: 'NOT_FOUND', message: 'x' } };
      }
      async parentOptions(): Promise<OrgStoreResult<{ subtreeSize: number; options: [] }>> {
        return { ok: true, value: { subtreeSize: 1, options: [] } };
      }
      async childCounts(): Promise<OrgStoreResult<Record<string, number>>> {
        return { ok: true, value: {} };
      }
      async countTotal(): Promise<OrgStoreResult<number>> {
        return { ok: true, value: 0 };
      }
    }
    _setOrganisationStore(new DupSlugStore());
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: orgBody,
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('ORG_SLUG_TAKEN');
  });

  it.each([
    ['DUPLICATE_EMAIL', 'USER_EXISTS'],
    ['DUPLICATE_PHONE', 'PHONE_EXISTS'],
  ] as const)(
    'maps a %s store error (a race past the pre-check) to %s (409)',
    async (storeCode, httpCode) => {
      const racing = new OrganisationStoreFake();
      racing.create = async () => ({ ok: false, error: { code: storeCode, message: 'race' } });
      _setOrganisationStore(racing);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/orgs/create',
        headers: AUTH_HEADER,
        payload: orgBody,
      });
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: { code: string } }).error.code).toBe(httpCode);
    },
  );

  it('401s POST /v1/orgs/create without a token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      payload: orgBody,
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
  });

  it('400 INVALID_PHONE on a malformed owner phone', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: { ...orgBody, owner: { ...orgBody.owner, phone: 'not-a-phone' } },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('INVALID_PHONE');
  });

  it('429 RATE_LIMITED when the submit rate checker rejects the request', async () => {
    _setSubmitRateChecker(async () => ({ allowed: false, retryAfterSeconds: 37 }));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: orgBody,
    });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('37');
    expect((res.json() as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
  });

  it('503 DB_UNAVAILABLE when findByOwnerEmail fails', async () => {
    orgStore.findByOwnerEmail = async () => ({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'db down' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: orgBody,
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe('DB_UNAVAILABLE');
  });

  it('503 DB_UNAVAILABLE (nothing written, no email) when the reviewer lookup fails', async () => {
    orgStore.findById = async () => ({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'db down' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: { ...orgBody, parent_id: '00000000-0000-4000-8000-0000000000f9' },
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe('DB_UNAVAILABLE');
    expect(await orgStore.findByOwnerEmail('ravi@enable.org')).toEqual({ ok: true, value: null });
    expect(mailer.outbox).toHaveLength(0);
  });

  it.each(['findByContactEmail', 'findByContactPhone', 'findByOwnerPhone'] as const)(
    '503 DB_UNAVAILABLE (nothing written) when the owner-contact pre-check %s fails',
    async (method) => {
      const down = () =>
        Promise.resolve({
          ok: false as const,
          error: { code: 'DB_UNAVAILABLE' as const, message: 'db down' },
        });
      if (method === 'findByOwnerPhone') orgStore.findByOwnerPhone = down;
      else userStore[method] = down;
      const res = await app.inject({
        method: 'POST',
        url: '/v1/orgs/create',
        headers: AUTH_HEADER,
        payload: orgBody,
      });
      expect(res.statusCode).toBe(503);
      expect((res.json() as { error: { code: string } }).error.code).toBe('DB_UNAVAILABLE');
      expect(await orgStore.findByOwnerEmail('ravi@enable.org')).toEqual({ ok: true, value: null });
    },
  );

  it('503 DB_UNAVAILABLE when orgStore.create fails with an unmapped error code', async () => {
    // NOT_FOUND is a real OrgStoreError variant, but the route only special-cases
    // DUPLICATE_NAME/DUPLICATE_SLUG — everything else (including this) falls
    // through to the generic DB_UNAVAILABLE branch.
    orgStore.create = async () => ({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'boom' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: orgBody,
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe('DB_UNAVAILABLE');
  });

  it('500 CONSENT_WRITE_FAILED (rolled back) when the consent config fails to load', async () => {
    loadConsentConfigMock.mockRejectedValueOnce(new Error('disk error'));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: { ...orgBody, owner: { ...orgBody.owner, email: 'consent-load-fail@enable.org' } },
    });
    expect(res.statusCode).toBe(500);
    expect((res.json() as { error: { code: string } }).error.code).toBe('CONSENT_WRITE_FAILED');
    const found = await orgStore.findByOwnerEmail('consent-load-fail@enable.org');
    expect(found.ok && found.value).toBeNull();
  });

  it('503 IDP_UNAVAILABLE (half-created org deleted) when the mirrored KC group create fails', async () => {
    idp.createGroup = async () => ({
      ok: false,
      error: { code: 'IDP_UNAVAILABLE', message: 'kc down' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: { ...orgBody, owner: { ...orgBody.owner, email: 'group-fail@enable.org' } },
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe('IDP_UNAVAILABLE');
    const found = await orgStore.findByOwnerEmail('group-fail@enable.org');
    // Deleted, not parked inactive: a row that never got a Keycloak owner
    // would keep the owner's contact and block a retry with PHONE_EXISTS.
    expect(found.ok && found.value).toBeNull();
  });

  it('409 USER_EXISTS (half-created org + group deleted) when the KC owner user already exists', async () => {
    await idp.createUser({ email: 'dup-owner@enable.org' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: { ...orgBody, owner: { ...orgBody.owner, email: 'dup-owner@enable.org' } },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('USER_EXISTS');
    const found = await orgStore.findByOwnerEmail('dup-owner@enable.org');
    // Deleted, not parked inactive: a row that never got a Keycloak owner
    // would keep the owner's contact and block a retry with PHONE_EXISTS.
    expect(found.ok && found.value).toBeNull();
    expect(idp.getGroup('grp-1')).toBeUndefined();
  });

  it('400 NAME_INVALID_CHARACTERS (half-created org deleted) when the IdP refuses the owner name', async () => {
    idp.createUser = async () => ({
      ok: false,
      error: { code: 'INVALID_NAME', message: 'name has a refused character' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: {
        ...orgBody,
        owner: { ...orgBody.owner, name: 'Ravi (Ops)', email: 'bad-name@enable.org' },
      },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('NAME_INVALID_CHARACTERS');
    const found = await orgStore.findByOwnerEmail('bad-name@enable.org');
    expect(found.ok && found.value).toBeNull();
  });

  it('503 IDP_UNAVAILABLE (half-created org + group deleted) when KC owner user creation fails for another reason', async () => {
    idp.createUser = async () => ({
      ok: false,
      error: { code: 'IDP_UNAVAILABLE', message: 'kc down' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: { ...orgBody, owner: { ...orgBody.owner, email: 'user-create-fail@enable.org' } },
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe('IDP_UNAVAILABLE');
    const found = await orgStore.findByOwnerEmail('user-create-fail@enable.org');
    // Deleted, not parked inactive: a row that never got a Keycloak owner
    // would keep the owner's contact and block a retry with PHONE_EXISTS.
    expect(found.ok && found.value).toBeNull();
  });

  it('still reports the original failure when cleaning up the half-created org fails too', async () => {
    idp.createUser = async () => ({
      ok: false,
      error: { code: 'IDP_UNAVAILABLE', message: 'kc down' },
    });
    let groupDeletes = 0;
    idp.deleteGroup = async () => {
      groupDeletes++;
      return { ok: false, error: { code: 'IDP_UNAVAILABLE', message: 'kc down' } };
    };
    let rowDeletes = 0;
    orgStore.deleteById = async () => {
      rowDeletes++;
      return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'db down' } };
    };
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: { ...orgBody, owner: { ...orgBody.owner, email: 'cleanup-fail@enable.org' } },
    });
    // Cleanup is best-effort and logged; it never masks the error that caused it.
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe('IDP_UNAVAILABLE');
    expect(groupDeletes).toBe(1);
    expect(rowDeletes).toBe(1);
  });

  it('503 DB_UNAVAILABLE when the final stamp update (kcGroupId/ownerKcSub) fails', async () => {
    const originalUpdate = orgStore.update.bind(orgStore);
    let calls = 0;
    orgStore.update = async (id, patch) => {
      calls++;
      if (calls === 1) return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'db down' } };
      return originalUpdate(id, patch);
    };
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs/create',
      headers: AUTH_HEADER,
      payload: { ...orgBody, owner: { ...orgBody.owner, email: 'stamp-fail@enable.org' } },
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe('DB_UNAVAILABLE');
    // Rolled back completely: no org row, no stranded Keycloak owner user, so
    // the same owner can register again.
    const org = await orgStore.findByOwnerEmail('stamp-fail@enable.org');
    expect(org.ok && org.value).toBeNull();
    const kc = await idp.findByEmail('stamp-fail@enable.org');
    expect(kc.ok && kc.value).toBeNull();
  });

  it('401s GET /v1/orgs without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/orgs' });
    expect(res.statusCode).toBe(401);
  });

  it('503 DB_UNAVAILABLE when GET /v1/orgs listActive fails', async () => {
    orgStore.listActive = async () => ({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'db down' },
    });
    const res = await app.inject({ method: 'GET', url: '/v1/orgs', headers: AUTH_HEADER });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe('DB_UNAVAILABLE');
  });
});
