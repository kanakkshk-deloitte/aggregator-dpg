import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { buildApp } from '../app.js';
import { UserStoreFake, _setUserStore, buildCoordinator } from '../services/user-store/index.js';
import {
  OrganisationStoreFake,
  buildOrganisation,
  buildDefaultOrg,
  _setOrganisationStore,
} from '../services/organisation-store/index.js';
import { IdpAdminFake, _setIdpAdmin } from '../services/idp-admin/index.js';
import { FakeMailer, _setMailer } from '@aggregator-dpg/mailer';
import {
  _resetTokenKey,
  mintApprovalToken,
  verifyApprovalToken,
} from '../services/approval-token.js';
import { _setApprovalVerifyRateChecker } from '../services/approval-verify-rate.js';
import { _setSignalStackWriter } from '../services/signalstack.js';
import { _setNetworkConfig } from '../services/network-config.js';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import { SignalStackWriterFake } from '@aggregator-dpg/signalstack-writer/testing';
import { SignalStackWriterBase } from '@aggregator-dpg/signalstack-writer/interface';
import { UpstreamError } from '@aggregator-dpg/shared-primitives/errors';
import { err, ok } from '@aggregator-dpg/shared-primitives/result';
import { getIdentityStore } from '../services/identity-store/index.js';
import { MEMORY_DEFAULT_ORG_ID } from '../services/user-store/memory.js';

/** The Default org every coordinator here belongs to unless a test moves it. */
const DEFAULT_ORG = MEMORY_DEFAULT_ORG_ID;
import type { IdentityStoreFake } from '../services/identity-store/testing.js';

const aggregatorId = '11111111-1111-1111-1111-111111111111';

describe('admin approval routes', () => {
  let app: FastifyInstance;
  let userStore: UserStoreFake;
  let idp: IdpAdminFake;
  let mailer: FakeMailer;
  let signalstack: SignalStackWriterFake;
  let orgStore: OrganisationStoreFake;
  let kcUserId: string;

  /** Moves a seeded coordinator to another org (the store has no org patch since 0028). */
  function setCoordinatorOrg(id: string, orgId: string): void {
    const row = userStore.findByIdSync(id);
    userStore.seed([{ ...row, parentOrgId: orgId, isDefaultOrg: orgId === DEFAULT_ORG }]);
  }

  beforeEach(async () => {
    _resetTokenKey();
    // The approval-verify limiter is fail-closed, so without an override it
    // would deny every request when Redis is unavailable in the test env.
    // Default to always-allow; the rate-limit test overrides this to deny.
    _setApprovalVerifyRateChecker(async () => ({
      allowed: true,
      retryAfterSeconds: 0,
    }));
    process.env.APPROVAL_TOKEN_SECRET = 'k'.repeat(48);
    process.env.PUBLIC_API_URL = 'http://api.local';
    process.env.PUBLIC_PORTAL_URL = 'http://portal.local';
    // Treat signalstack as enabled so the approval route hits our fake.
    process.env.SIGNALSTACK_BASE_URL = 'http://stub-signalstack';
    process.env.SIGNALSTACK_ADMIN_KEY = 'stub-key';
    process.env.SIGNALSTACK_ACTING_ORG_ID = 'org_platform';

    userStore = new UserStoreFake();
    userStore.seed([
      buildCoordinator({
        id: aggregatorId,
        orgSlug: 'trrain-abcd',
        actorType: 'aggregator',
        type: null,
        name: 'TRRAIN',
        contact: {
          name: 'Asha Rao',
          phone: '+919876543210',
          email: 'asha@trrain.org',
        },
        status: 'pending',
      }),
    ]);
    _setUserStore(userStore);

    idp = new IdpAdminFake();
    const created = await idp.createUser({
      email: 'asha@trrain.org',
      firstName: 'Asha',
      lastName: 'Rao',
      enabled: false,
      attributes: { aggregator_id: aggregatorId, decision_made: 'pending' },
    });
    if (!created.ok) throw new Error('seed failed');
    kcUserId = created.value.id;
    _setIdpAdmin(idp);

    mailer = new FakeMailer();
    _setMailer(mailer);

    signalstack = new SignalStackWriterFake();
    _setSignalStackWriter(signalstack);

    orgStore = new OrganisationStoreFake();
    // Every coordinator has an org since 0028; the seeded one is in Default.
    orgStore.seed([buildDefaultOrg()]);
    _setOrganisationStore(orgStore);

    // Approval flow now reads cfg.domainIds from the network config —
    // pin a blue_dot-shaped config so the legacy `['seeker','provider']`
    // assertions in this file still hold.
    _setNetworkConfig(buildBlueDotConfig());

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    _setApprovalVerifyRateChecker(null);
    _setUserStore(null);
    _setIdpAdmin(null);
    _setMailer(null);
    _setSignalStackWriter(null);
    _setNetworkConfig(null);
    _setOrganisationStore(null);
  });

  it('GET /read/:id returns a 429 HTML page when the verify rate limit is exceeded', async () => {
    _setApprovalVerifyRateChecker(async () => ({
      allowed: false,
      retryAfterSeconds: 42,
    }));
    const { token } = await mintApprovalToken({
      org: DEFAULT_ORG,
      aggregatorId,
      intent: 'approve',
    });
    const res = await app.inject({
      method: 'GET',
      url: `/admin/v1/aggregator-registrations/read/${aggregatorId}?token=${encodeURIComponent(token)}`,
    });
    expect(res.statusCode).toBe(429);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['retry-after']).toBe('42');
    expect(res.body).toContain('Too many attempts');
  });

  it('POST /decision/:id returns a 429 HTML page when the verify rate limit is exceeded', async () => {
    _setApprovalVerifyRateChecker(async () => ({
      allowed: false,
      retryAfterSeconds: 30,
    }));
    const { token } = await mintApprovalToken({
      org: DEFAULT_ORG,
      aggregatorId,
      intent: 'approve',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'approve' },
    });
    expect(res.statusCode).toBe(429);
    expect(res.body).toContain('Too many attempts');
    // The limit fires before any decision is applied.
    const dbAfter = await userStore.findById(aggregatorId);
    if (dbAfter.ok && dbAfter.value) expect(dbAfter.value.status).toBe('pending');
  });

  it('POST /renew/:id returns a 429 HTML page when the verify rate limit is exceeded', async () => {
    _setApprovalVerifyRateChecker(async () => ({
      allowed: false,
      retryAfterSeconds: 30,
    }));
    const { token } = await mintApprovalToken({
      org: DEFAULT_ORG,
      aggregatorId,
      intent: 'approve',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/renew/${aggregatorId}`,
      payload: { token },
    });
    expect(res.statusCode).toBe(429);
    expect(res.body).toContain('Too many attempts');
  });

  it('GET /read/:id renders the single review page with both actions', async () => {
    const { token } = await mintApprovalToken({
      org: DEFAULT_ORG,
      aggregatorId,
      intent: 'approve',
    });
    const res = await app.inject({
      method: 'GET',
      url: `/admin/v1/aggregator-registrations/read/${aggregatorId}?token=${encodeURIComponent(token)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    // One link → a review page carrying BOTH approve and reject.
    expect(res.body).toContain('Review aggregator application');
    expect(res.body).toContain('name="decision" value="approve"');
    expect(res.body).toContain('name="decision" value="reject"');
    expect(res.body).toContain('asha@trrain.org');
    expect(res.body).toContain(`/admin/v1/aggregator-registrations/decision/${aggregatorId}`);
    // 0027: opening the review link records the coordinator's IdP login.
    const identities = (getIdentityStore() as IdentityStoreFake).all();
    expect(identities).toHaveLength(1);
    expect(identities[0]).toMatchObject({ userId: aggregatorId, provider: 'keycloak' });
  });

  it('GET /read/:id shows already-approved when aggregator.status=active', async () => {
    await userStore.updateStatus(aggregatorId, 'active', 'admin');
    const { token } = await mintApprovalToken({
      org: DEFAULT_ORG,
      aggregatorId,
      intent: 'approve',
    });
    const res = await app.inject({
      method: 'GET',
      url: `/admin/v1/aggregator-registrations/read/${aggregatorId}?token=${encodeURIComponent(token)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Already approved');
  });

  it('GET /read/:id shows already-rejected when aggregator.status=inactive', async () => {
    await userStore.updateStatus(aggregatorId, 'inactive', 'admin');
    const { token } = await mintApprovalToken({ org: DEFAULT_ORG, aggregatorId, intent: 'reject' });
    const res = await app.inject({
      method: 'GET',
      url: `/admin/v1/aggregator-registrations/read/${aggregatorId}?token=${encodeURIComponent(token)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Already rejected');
  });

  it('GET /read/:id rejects malformed token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/admin/v1/aggregator-registrations/read/${aggregatorId}?token=junk&intent=approve`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Invalid link');
  });

  it('GET /read/:id rejects token whose subject does not match the path id', async () => {
    const { token } = await mintApprovalToken({
      aggregatorId: '99999999-9999-9999-9999-999999999999',
      intent: 'approve',
    });
    const res = await app.inject({
      method: 'GET',
      url: `/admin/v1/aggregator-registrations/read/${aggregatorId}?token=${encodeURIComponent(token)}&intent=approve`,
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /decision/:id approve flips DB status, enables KC user, stamps decision_made, emails applicant', async () => {
    const { token } = await mintApprovalToken({
      org: DEFAULT_ORG,
      aggregatorId,
      intent: 'approve',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'approve' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Application approved');

    const dbAfter = await userStore.findById(aggregatorId);
    expect(dbAfter.ok).toBe(true);
    if (dbAfter.ok && dbAfter.value) {
      expect(dbAfter.value.status).toBe('active');
      // signalstack_org_id is mirrored from the upsert response onto the
      // aggregators row so worker + anonymous link submission paths can
      // read it without touching Keycloak.
      expect(dbAfter.value.signalstackOrgId).toBeDefined();
      expect(dbAfter.value.signalstackOrgId).not.toBeNull();
    }

    const after = await idp.findById(kcUserId);
    if (after.ok && after.value) {
      expect(after.value.enabled).toBe(true);
      expect(after.value.attributes?.decision_made?.[0]).toBe('approved');
      // decided_at / rejection_reason attributes are no longer written to KC.
      expect(after.value.attributes?.decided_at).toBeUndefined();
      // signalstack_org_id is written from the upsert response on approval.
      const orgIdAttr = after.value.attributes?.signalstack_org_id?.[0];
      expect(orgIdAttr).toBeDefined();
      const aggregators = signalstack.listAggregators();
      expect(aggregators).toHaveLength(1);
      expect(aggregators[0]?.external_id).toBe(aggregatorId);
      expect(aggregators[0]?.name).toBe('TRRAIN');
      expect(aggregators[0]?.slug).toBe('trrain-abcd');
      expect(orgIdAttr).toBe(aggregators[0]?.org_id);
      // KC attr and DB mirror must agree.
      if (dbAfter.ok && dbAfter.value) {
        expect(dbAfter.value.signalstackOrgId).toBe(orgIdAttr);
      }
    }

    expect(mailer.outbox).toHaveLength(1);
    const m = mailer.outbox[0];
    if (!m) throw new Error('no mail captured');
    expect(m.to).toBe('asha@trrain.org');
    expect(m.subject).toContain('approved');
  });

  it('POST /decision/:id approve is single-use via CAS — a second click sends no duplicate email', async () => {
    const { token } = await mintApprovalToken({
      org: DEFAULT_ORG,
      aggregatorId,
      intent: 'approve',
    });
    const first = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'approve' },
    });
    expect(first.statusCode).toBe(200);
    expect(first.body).toContain('Application approved');

    const second = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'approve' },
    });
    expect(second.statusCode).toBe(200);
    expect(second.body).toContain('Already approved');
    // Applicant "approved" email went out exactly once.
    expect(mailer.outbox).toHaveLength(1);
  });

  it('POST /decision/:id approve aborts with 503 when signalstack upsert fails — DB stays pending, KC user stays disabled', async () => {
    // Hard-gate policy: signalstack upsert is step 1 of approval. If it
    // fails, the route returns 503 without touching DB status or KC user
    // state, so the admin can re-click the approval link once signalstack
    // is reachable again. Single-use guard reads DB status (still pending)
    // and the upsert is idempotent on external_id, so retry is clean.
    class FailingUpsertWriter extends SignalStackWriterBase {
      async onboard() {
        return err(new UpstreamError('not used', { code: 'X' }));
      }
      async upsertAggregator() {
        return err(
          new UpstreamError('signalstack upsert returned 503', {
            code: 'SIGNALSTACK_SERVER_ERROR',
          }),
        );
      }
      async fetchDashboard() {
        return err(new UpstreamError('not used', { code: 'X' }));
      }
      async exportDashboardCsv() {
        return err(new UpstreamError('not used', { code: 'X' }));
      }
      async fetchDecryptedProfiles() {
        return err(new UpstreamError('not used', { code: 'X' }));
      }
      async probeUser() {
        return err(new UpstreamError('not used', { code: 'X' }));
      }
    }
    _setSignalStackWriter(new FailingUpsertWriter());

    const { token } = await mintApprovalToken({
      org: DEFAULT_ORG,
      aggregatorId,
      intent: 'approve',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'approve' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain('Action failed');

    // KC user remains disabled — login still blocked. `decision_made` stays
    // at the registration-time default of 'pending'.
    const after = await idp.findById(kcUserId);
    if (after.ok && after.value) {
      expect(after.value.enabled).toBe(false);
      expect(after.value.attributes?.decision_made?.[0]).toBe('pending');
      expect(after.value.attributes?.signalstack_org_id).toBeUndefined();
    }
    // DB status stays pending — admin can re-click to retry.
    const dbAfter = await userStore.findById(aggregatorId);
    if (dbAfter.ok && dbAfter.value) {
      expect(dbAfter.value.status).toBe('pending');
      expect(dbAfter.value.signalstackOrgId).toBeNull();
    }
  });

  it('POST /decision/:id approve aborts with 503 when KC enableUser fails — DB stays pending, signalstack idempotent on retry', async () => {
    // Step 2 (idp.enableUser) failure path: signalstack already wrote
    // (step 1 succeeded), but KC is unreachable. DB status must stay
    // pending so admin can re-click. signalstack.upsertAggregator is
    // idempotent on external_id, so the retry second call returns the
    // same orgId.
    const originalEnable = idp.enableUser.bind(idp);
    let enableCalls = 0;
    idp.enableUser = async (id: string) => {
      enableCalls++;
      if (enableCalls === 1) {
        return { ok: false, error: { code: 'IDP_UNAVAILABLE', message: 'KC unreachable' } };
      }
      return originalEnable(id);
    };

    const { token } = await mintApprovalToken({
      org: DEFAULT_ORG,
      aggregatorId,
      intent: 'approve',
    });

    const first = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'approve' },
    });
    expect(first.statusCode).toBe(503);
    expect(first.body).toContain('Identity service unavailable');

    // KC user still disabled; DB still pending.
    const afterFirst = await idp.findById(kcUserId);
    if (afterFirst.ok && afterFirst.value) {
      expect(afterFirst.value.enabled).toBe(false);
    }
    const dbAfterFirst = await userStore.findById(aggregatorId);
    if (dbAfterFirst.ok && dbAfterFirst.value) {
      expect(dbAfterFirst.value.status).toBe('pending');
    }

    // Retry — KC now responsive. Approval completes; signalstack returns
    // same orgId via the in-memory fake's idempotency on external_id.
    const second = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'approve' },
    });
    expect(second.statusCode).toBe(200);
    expect(second.body).toContain('Application approved');

    const dbAfter = await userStore.findById(aggregatorId);
    if (dbAfter.ok && dbAfter.value) {
      expect(dbAfter.value.status).toBe('active');
      expect(dbAfter.value.signalstackOrgId).not.toBeNull();
    }
    const after = await idp.findById(kcUserId);
    if (after.ok && after.value) {
      expect(after.value.enabled).toBe(true);
    }
    // Signalstack idempotency: upsert was called twice, both with same
    // external_id, returning the same org row.
    const aggregators = signalstack.listAggregators();
    expect(aggregators).toHaveLength(1);
  });

  it('POST /decision/:id approve succeeds on retry after signalstack recovers', async () => {
    // First click: signalstack down → 503, no state change.
    class FailingUpsertWriter extends SignalStackWriterBase {
      async onboard() {
        return err(new UpstreamError('not used', { code: 'X' }));
      }
      async upsertAggregator() {
        return err(new UpstreamError('down', { code: 'SIGNALSTACK_SERVER_ERROR' }));
      }
      async fetchDashboard() {
        return err(new UpstreamError('not used', { code: 'X' }));
      }
      async exportDashboardCsv() {
        return err(new UpstreamError('not used', { code: 'X' }));
      }
      async fetchDecryptedProfiles() {
        return err(new UpstreamError('not used', { code: 'X' }));
      }
      async probeUser() {
        return err(new UpstreamError('not used', { code: 'X' }));
      }
    }
    _setSignalStackWriter(new FailingUpsertWriter());
    const { token } = await mintApprovalToken({
      org: DEFAULT_ORG,
      aggregatorId,
      intent: 'approve',
    });
    const first = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'approve' },
    });
    expect(first.statusCode).toBe(503);

    // Second click: signalstack reachable — approval completes.
    _setSignalStackWriter(signalstack);
    const second = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'approve' },
    });
    expect(second.statusCode).toBe(200);
    expect(second.body).toContain('Application approved');

    const dbAfter = await userStore.findById(aggregatorId);
    if (dbAfter.ok && dbAfter.value) {
      expect(dbAfter.value.status).toBe('active');
      expect(dbAfter.value.signalstackOrgId).not.toBeNull();
    }
    const after = await idp.findById(kcUserId);
    if (after.ok && after.value) {
      expect(after.value.enabled).toBe(true);
    }
  });

  it('POST /decision/:id approve skips upsert cleanly when signalstack writer is disabled', async () => {
    _setSignalStackWriter(null);
    const { token } = await mintApprovalToken({
      org: DEFAULT_ORG,
      aggregatorId,
      intent: 'approve',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'approve' },
    });
    expect(res.statusCode).toBe(200);

    const after = await idp.findById(kcUserId);
    if (after.ok && after.value) {
      expect(after.value.attributes?.signalstack_org_id).toBeUndefined();
    }
    const dbAfter = await userStore.findById(aggregatorId);
    if (dbAfter.ok && dbAfter.value) {
      expect(dbAfter.value.signalstackOrgId).toBeNull();
    }
  });

  // Capturing writer factory — records every upsertAggregator input so
  // domain-restriction tests can assert what the approval flow dispatched
  // without depending on the in-memory fake's internals.
  const buildCapturingWriter = (
    captured: Array<{ external_id: string; domains: string[] | undefined }>,
    orgIdSeed: string,
  ) =>
    new (class extends SignalStackWriterBase {
      async onboard() {
        return err(new UpstreamError('not used', { code: 'X' }));
      }
      async upsertAggregator(input: { external_id: string; domains?: string[] | undefined }) {
        captured.push({ external_id: input.external_id, domains: input.domains });
        return ok({
          org_id: orgIdSeed,
          external_id: input.external_id,
          name: 'TRRAIN',
          slug: 'trrain-abcd',
        });
      }
      async fetchDashboard() {
        return err(new UpstreamError('not used', { code: 'X' }));
      }
      async exportDashboardCsv() {
        return err(new UpstreamError('not used', { code: 'X' }));
      }
      async fetchDecryptedProfiles() {
        return err(new UpstreamError('not used', { code: 'X' }));
      }
      async probeUser() {
        return err(new UpstreamError('not used', { code: 'X' }));
      }
    })();

  const seedAggregatorWithType = (type: string | null) => {
    userStore.seed([
      buildCoordinator({
        id: aggregatorId,
        orgSlug: 'trrain-abcd',
        actorType: 'aggregator',
        type,
        name: 'TRRAIN',
        contact: { name: 'Asha Rao', phone: '+919876543210', email: 'asha@trrain.org' },
        status: 'pending',
      }),
    ]);
  };

  it.each([
    ['seeker', ['seeker']],
    ['provider', ['provider']],
  ])(
    'POST /decision/:id approve forwards only `%s` to signalstack domains',
    async (type, expectedDomains) => {
      seedAggregatorWithType(type);
      const captured: Array<{ external_id: string; domains: string[] | undefined }> = [];
      _setSignalStackWriter(buildCapturingWriter(captured, `mem-org-${type}`));

      const { token } = await mintApprovalToken({
        org: DEFAULT_ORG,
        aggregatorId,
        intent: 'approve',
      });
      const res = await app.inject({
        method: 'POST',
        url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
        payload: { token, decision: 'approve' },
      });
      expect(res.statusCode).toBe(200);
      expect(captured).toHaveLength(1);
      expect(captured[0]?.domains).toEqual(expectedDomains);
    },
  );

  it('POST /decision/:id approve falls back to both domains when aggregator.type is null (legacy)', async () => {
    // Default seed uses type: null. Capture upsert + assert the
    // legacy fallback list goes out.
    const captured: Array<{ external_id: string; domains: string[] | undefined }> = [];
    _setSignalStackWriter(buildCapturingWriter(captured, 'mem-org-legacy'));

    const { token } = await mintApprovalToken({
      org: DEFAULT_ORG,
      aggregatorId,
      intent: 'approve',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'approve' },
    });
    expect(res.statusCode).toBe(200);
    expect(captured[0]?.domains).toEqual(['seeker', 'provider']);
  });

  it('POST /decision/:id reject flips DB status to inactive, keeps user disabled, emails applicant with reason', async () => {
    const { token } = await mintApprovalToken({ org: DEFAULT_ORG, aggregatorId, intent: 'reject' });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'reject', reason: 'incomplete documentation' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Application rejected');

    const dbAfter = await userStore.findById(aggregatorId);
    if (dbAfter.ok && dbAfter.value) {
      expect(dbAfter.value.status).toBe('inactive');
    }

    const after = await idp.findById(kcUserId);
    if (after.ok && after.value) {
      expect(after.value.enabled).toBe(false);
      expect(after.value.attributes?.decision_made?.[0]).toBe('rejected');
      // rejection_reason is no longer persisted on KC (audit-log only).
      expect(after.value.attributes?.rejection_reason).toBeUndefined();
    }

    expect(mailer.outbox).toHaveLength(1);
    const rejected = mailer.outbox[0];
    if (!rejected) throw new Error('no mail captured');
    expect(rejected.text).toContain('incomplete documentation');
  });

  it('POST /decision/:id approve is idempotent — second click does not re-send', async () => {
    const { token } = await mintApprovalToken({
      org: DEFAULT_ORG,
      aggregatorId,
      intent: 'approve',
    });
    const first = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'approve' },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'approve' },
    });
    expect(second.statusCode).toBe(200);
    expect(second.body).toContain('Already approved');
    expect(mailer.outbox).toHaveLength(1);
  });

  it('POST /decision/:id reject is idempotent — second click does not re-send', async () => {
    const { token } = await mintApprovalToken({ org: DEFAULT_ORG, aggregatorId, intent: 'reject' });
    const first = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'reject', reason: 'duplicate org' },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'reject', reason: 'duplicate org' },
    });
    expect(second.statusCode).toBe(200);
    expect(second.body).toContain('Already rejected');
    expect(mailer.outbox).toHaveLength(1);
  });

  it('POST /decision/:id returns 400 when decision body is malformed', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token: '', decision: 'maybe' },
    });
    expect(res.statusCode).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // Resend helpers
  // ---------------------------------------------------------------------------

  let resendIdCounter = 0;

  /** Seeds a fresh pending aggregator + disabled KC user and returns its id. */
  async function seedPendingAggregator(): Promise<{ id: string }> {
    resendIdCounter++;
    const id = `aaaaaaaa-bbbb-cccc-dddd-${String(resendIdCounter).padStart(12, '0')}`;
    userStore.seed([
      buildCoordinator({
        id,
        orgSlug: `resend-org-${resendIdCounter}`,
        actorType: 'aggregator',
        type: null,
        name: 'Resend Org',
        contact: { name: 'Test User', phone: '+919000000001', email: 'resend@test.local' },
        contactPhone: '+919000000001',
        status: 'pending',
      }),
    ]);
    const created = await idp.createUser({
      email: 'resend@test.local',
      firstName: 'Test',
      lastName: 'User',
      enabled: false,
      attributes: { aggregator_id: id, decision_made: 'pending' },
    });
    if (!created.ok) throw new Error('seed KC user failed');
    return { id };
  }

  /**
   * Mints an approve token with iat/exp in the past (expired but valid signature)
   * for the given aggregatorId. Mirrors the pattern used in approval-token.test.ts.
   */
  async function mintExpiredApproveToken(
    aggregatorId: string,
    org: string | null = DEFAULT_ORG,
  ): Promise<string> {
    const key = new TextEncoder().encode(process.env.APPROVAL_TOKEN_SECRET);
    return new SignJWT({ intent: 'approve', ...(org ? { org } : {}) })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(aggregatorId)
      .setIssuer('aggregator-api')
      .setAudience('aggregator-admin')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(key);
  }

  // ---------------------------------------------------------------------------
  // Renew (inline regenerate) route tests
  // ---------------------------------------------------------------------------

  it('renew re-arms an expired token and shows the confirm page inline (no email)', async () => {
    const { id } = await seedPendingAggregator();
    const expired = await mintExpiredApproveToken(id);
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/renew/${id}`,
      payload: { token: expired },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain(`/admin/v1/aggregator-registrations/decision/${id}`);
    expect(mailer.outbox.length).toBe(0);
  });

  it('renew keeps the org binding of the expired link', async () => {
    const { id } = await seedPendingAggregator();
    const expired = await mintExpiredApproveToken(id);
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/renew/${id}`,
      payload: { token: expired },
    });
    expect(res.statusCode).toBe(200);
    const fresh = /name="token" value="([^"]+)"/.exec(res.body)?.[1] ?? '';
    const v = await verifyApprovalToken(fresh);
    expect(v.ok && v.org).toBe(DEFAULT_ORG);
  });

  it('renew refuses an org-less link (the one-release pre-0028 path is gone, Phase 5)', async () => {
    const { id } = await seedPendingAggregator();
    const expired = await mintExpiredApproveToken(id, null);
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/renew/${id}`,
      payload: { token: expired },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Token does not match this organisation.');
  });

  it('renew never re-binds a link minted for another org', async () => {
    const { id } = await seedPendingAggregator();
    const key = new TextEncoder().encode(process.env.APPROVAL_TOKEN_SECRET);
    const otherOrg = await new SignJWT({ intent: 'approve', org: 'org-A' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(id)
      .setIssuer('aggregator-api')
      .setAudience('aggregator-admin')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(key);
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/renew/${id}`,
      payload: { token: otherOrg },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Token does not match this organisation.');
  });

  it('refuses the review page for an org-less link (Phase 5)', async () => {
    const { token } = await mintApprovalToken({ aggregatorId, intent: 'approve' });
    const res = await app.inject({
      method: 'GET',
      url: `/admin/v1/aggregator-registrations/read/${aggregatorId}?token=${encodeURIComponent(token)}&intent=approve`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Token does not match this organisation.');
  });

  it('refuses the review page for a link bound to another org', async () => {
    const { token } = await mintApprovalToken({ aggregatorId, intent: 'approve', org: 'org-A' });
    const res = await app.inject({
      method: 'GET',
      url: `/admin/v1/aggregator-registrations/read/${aggregatorId}?token=${encodeURIComponent(token)}&intent=approve`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Token does not match this organisation.');
  });

  it('refuses a decision with an org-less link (Phase 5)', async () => {
    const { token } = await mintApprovalToken({ aggregatorId, intent: 'approve' });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'approve' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Token does not match this organisation.');
    const stored = await userStore.findById(aggregatorId);
    expect(stored.ok && stored.value?.status).toBe('pending');
  });

  it('renew rejects a malformed token with 400', async () => {
    const { id } = await seedPendingAggregator();
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/renew/${id}`,
      payload: { token: 'not-a-jwt' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('renew shows already-decided for an active record', async () => {
    const { id } = await seedPendingAggregator();
    await userStore.updateStatus(id, 'active', 'admin');
    const expired = await mintExpiredApproveToken(id);
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/renew/${id}`,
      payload: { token: expired },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('already');
  });

  it('expired approval link page offers an inline regenerate step (no email)', async () => {
    const { id } = await seedPendingAggregator();
    const expired = await mintExpiredApproveToken(id);
    const res = await app.inject({
      method: 'GET',
      url: `/admin/v1/aggregator-registrations/read/${id}?token=${encodeURIComponent(expired)}&intent=approve`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Link expired');
    expect(res.body).toContain('Regenerate &amp; review');
    expect(res.body).toContain(`/admin/v1/aggregator-registrations/renew/${id}`);
    expect(mailer.outbox.length).toBe(0);
  });

  it('rejects a coordinator decision when the token org claim mismatches parent_org_id', async () => {
    // The seeded coordinator belongs to org-B; the token is minted for org-A.
    setCoordinatorOrg(aggregatorId, 'org-B');
    const { token } = await mintApprovalToken({
      aggregatorId,
      intent: 'approve',
      org: 'org-A',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'approve' },
    });
    expect(res.statusCode).toBe(400);
    // The coordinator must still be pending (decision aborted).
    const stored = await userStore.findById(aggregatorId);
    expect(stored.ok && stored.value?.status).toBe('pending');
  });

  it('allows the decision when the token org claim matches parent_org_id', async () => {
    setCoordinatorOrg(aggregatorId, 'org-A');
    orgStore.seed([buildOrganisation({ id: 'org-A', slug: 'a', status: 'active' })]);
    const { token } = await mintApprovalToken({
      aggregatorId,
      intent: 'approve',
      org: 'org-A',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'approve' },
    });
    expect(res.statusCode).toBe(200);
    const stored = await userStore.findById(aggregatorId);
    expect(stored.ok && stored.value?.status).toBe('active');
  });

  // ---------------------------------------------------------------------------
  // Org re-validation, soft-fail warn branches, hard-fail branches, and the
  // loadAggregatorAndUser / applicantNameOf helpers.
  // ---------------------------------------------------------------------------

  it('renders TARGET_ORG_INACTIVE when the bound org is re-validated as inactive at decision time', async () => {
    {
      setCoordinatorOrg(aggregatorId, 'org-A');
      orgStore.seed([buildOrganisation({ id: 'org-A', slug: 'a', status: 'pending' })]);
      const { token } = await mintApprovalToken({ aggregatorId, intent: 'approve', org: 'org-A' });
      const res = await app.inject({
        method: 'POST',
        url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
        payload: { token, decision: 'approve' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Organisation unavailable');
      const stored = await userStore.findById(aggregatorId);
      expect(stored.ok && stored.value?.status).toBe('pending');
    }
  });

  it('approve still succeeds (soft-fail, warn-logged) when the decision_made stamp fails', async () => {
    idp.setUserDecision = async () => ({
      ok: false,
      error: { code: 'IDP_UNAVAILABLE', message: 'stamp failed' },
    });
    const { token } = await mintApprovalToken({
      org: DEFAULT_ORG,
      aggregatorId,
      intent: 'approve',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'approve' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Application approved');
    const dbAfter = await userStore.findById(aggregatorId);
    if (dbAfter.ok && dbAfter.value) expect(dbAfter.value.status).toBe('active');
  });

  it('approve still succeeds (soft-fail, warn-logged) when stamping signalstack_org_id on KC + DB both fail', async () => {
    idp.setAttributes = async () => ({
      ok: false,
      error: { code: 'IDP_UNAVAILABLE', message: 'attr write failed' },
    });
    userStore.updateSignalstackOrgId = async () => ({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'db write failed' },
    });
    const { token } = await mintApprovalToken({
      org: DEFAULT_ORG,
      aggregatorId,
      intent: 'approve',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'approve' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Application approved');
  });

  it('approve returns 503 without side effects when the atomic CAS update fails', async () => {
    userStore.approveFromPending = async () => ({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'cas failed' },
    });
    const { token } = await mintApprovalToken({
      org: DEFAULT_ORG,
      aggregatorId,
      intent: 'approve',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'approve' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain('Action failed');
    expect(mailer.outbox).toHaveLength(0);
  });

  it('approve renders already-decided (no email) when the CAS loses a concurrent race', async () => {
    // Simulates a second in-flight request winning the CAS between our
    // pending-check read and the update — the store reports success but a
    // null value, meaning some other request already flipped the row.
    userStore.approveFromPending = async () => ({ ok: true, value: null });
    const { token } = await mintApprovalToken({
      org: DEFAULT_ORG,
      aggregatorId,
      intent: 'approve',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'approve' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Already approved');
    expect(mailer.outbox).toHaveLength(0);
  });

  it('approve still returns 200 when the applicant approval email fails to send', async () => {
    mailer.send = async () => ({
      ok: false,
      error: { code: 'TRANSPORT_FAILED', message: 'smtp down' },
    });
    const { token } = await mintApprovalToken({
      org: DEFAULT_ORG,
      aggregatorId,
      intent: 'approve',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'approve' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Application approved');
    const dbAfter = await userStore.findById(aggregatorId);
    expect(dbAfter.ok && dbAfter.value?.status).toBe('active');
  });

  it('reject returns 503 without side effects when the status write fails', async () => {
    // Reject now stamps write-once rejected_at via update() (#726), not updateStatus.
    userStore.update = async () => ({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'db down' },
    });
    const { token } = await mintApprovalToken({ org: DEFAULT_ORG, aggregatorId, intent: 'reject' });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'reject' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain('Action failed');
    expect(mailer.outbox).toHaveLength(0);
  });

  it('reject still succeeds (soft-fail, warn-logged) when the decision_made stamp fails', async () => {
    idp.setUserDecision = async () => ({
      ok: false,
      error: { code: 'IDP_UNAVAILABLE', message: 'stamp failed' },
    });
    const { token } = await mintApprovalToken({ org: DEFAULT_ORG, aggregatorId, intent: 'reject' });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'reject' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Application rejected');
  });

  it('reject still returns 200 when the applicant rejection email fails to send', async () => {
    mailer.send = async () => ({
      ok: false,
      error: { code: 'TRANSPORT_FAILED', message: 'smtp down' },
    });
    const { token } = await mintApprovalToken({ org: DEFAULT_ORG, aggregatorId, intent: 'reject' });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'reject' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Application rejected');
    const dbAfter = await userStore.findById(aggregatorId);
    expect(dbAfter.ok && dbAfter.value?.status).toBe('inactive');
  });

  it('503s when loading the aggregator record fails (store unavailable)', async () => {
    userStore.findById = async () => ({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'db down' },
    });
    const { token } = await mintApprovalToken({
      org: DEFAULT_ORG,
      aggregatorId,
      intent: 'approve',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'approve' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain('Could not load aggregator record');
  });

  it('404s when the aggregator id does not exist', async () => {
    const unknownId = '22222222-2222-2222-2222-222222222299';
    const { token } = await mintApprovalToken({
      org: DEFAULT_ORG,
      aggregatorId: unknownId,
      intent: 'approve',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${unknownId}`,
      payload: { token, decision: 'approve' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('Aggregator not found');
  });

  it('503s when the identity-service lookup fails', async () => {
    idp.findByAttribute = async () => ({
      ok: false,
      error: { code: 'IDP_UNAVAILABLE', message: 'kc down' },
    });
    const { token } = await mintApprovalToken({
      org: DEFAULT_ORG,
      aggregatorId,
      intent: 'approve',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'approve' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain('Could not load identity record');
  });

  it('404s when the identity record is missing for an otherwise-known aggregator', async () => {
    idp.findByAttribute = async () => ({ ok: true, value: null });
    const { token } = await mintApprovalToken({
      org: DEFAULT_ORG,
      aggregatorId,
      intent: 'approve',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'approve' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('Identity record missing');
  });

  it('falls back to the KC first+last name when the aggregator has no contact.name', async () => {
    userStore.seed([
      buildCoordinator({
        id: aggregatorId,
        orgSlug: 'trrain-abcd',
        actorType: 'aggregator',
        type: null,
        name: 'TRRAIN',
        contact: { name: '', phone: '+919876543210', email: 'asha@trrain.org' },
        status: 'pending',
      }),
    ]);
    // firstName/lastName were seeded in beforeEach as Asha/Rao already.
    const { token } = await mintApprovalToken({ org: DEFAULT_ORG, aggregatorId, intent: 'reject' });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'reject' },
    });
    expect(res.statusCode).toBe(200);
    const rejected = mailer.outbox[0];
    expect(rejected?.text).toContain('Hi Asha Rao,');
  });

  it('falls back to the KC email when neither contact.name nor KC first/last name are set', async () => {
    userStore.seed([
      buildCoordinator({
        id: aggregatorId,
        orgSlug: 'trrain-abcd',
        actorType: 'aggregator',
        type: null,
        name: 'TRRAIN',
        contact: { name: '', phone: '+919876543210', email: 'asha@trrain.org' },
        status: 'pending',
      }),
    ]);
    const kc = await idp.findById(kcUserId);
    if (kc.ok && kc.value) {
      delete kc.value.firstName;
      delete kc.value.lastName;
    }
    const { token } = await mintApprovalToken({ org: DEFAULT_ORG, aggregatorId, intent: 'reject' });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'reject' },
    });
    expect(res.statusCode).toBe(200);
    const rejected = mailer.outbox[0];
    expect(rejected?.text).toContain('Hi asha@trrain.org,');
  });

  // ---------------------------------------------------------------------------
  // Branch coverage: missing-token, lookup-failure, invalid-token and
  // decision-outcome paths the flows above don't reach.
  // ---------------------------------------------------------------------------

  it('GET /read/:id with no token shows the missing-token page', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/admin/v1/aggregator-registrations/read/${aggregatorId}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('GET /read/:id returns 503 when loading the aggregator record fails', async () => {
    userStore.findById = async () => ({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'db down' },
    });
    const { token } = await mintApprovalToken({
      org: DEFAULT_ORG,
      aggregatorId,
      intent: 'approve',
    });
    const res = await app.inject({
      method: 'GET',
      url: `/admin/v1/aggregator-registrations/read/${aggregatorId}?token=${encodeURIComponent(token)}`,
    });
    expect(res.statusCode).toBe(503);
  });

  it('GET /read/:id renders the invited-email line when the coordinator was invited', async () => {
    userStore.seed([
      buildCoordinator({
        id: aggregatorId,
        orgSlug: 'trrain-abcd',
        actorType: 'aggregator',
        type: null,
        name: 'TRRAIN',
        contact: { name: 'Asha Rao', phone: '+919876543210', email: 'asha@trrain.org' },
        status: 'pending',
        inviteEmail: 'invited@trrain.org',
      }),
    ]);
    const { token } = await mintApprovalToken({
      org: DEFAULT_ORG,
      aggregatorId,
      intent: 'approve',
    });
    const res = await app.inject({
      method: 'GET',
      url: `/admin/v1/aggregator-registrations/read/${aggregatorId}?token=${encodeURIComponent(token)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('invited@trrain.org');
  });

  it('POST /decision/:id shows the invalid-token page for a bad (but well-formed) token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token: 'not-a-jwt', decision: 'approve' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Invalid link');
  });

  it('POST /decision/:id renders not-found when the decision service cannot find the row', async () => {
    // The route loads the aggregator (ok twice: its own lookup + the decision
    // service's), but the post-CAS re-read finds the row gone, so the decision
    // service returns `not_found`.
    userStore.approveFromPending = async () => ({ ok: true, value: null });
    let calls = 0;
    const orig = userStore.findById.bind(userStore);
    userStore.findById = async (id: string) => {
      calls += 1;
      return calls >= 3 ? { ok: true, value: null } : orig(id);
    };
    const { token } = await mintApprovalToken({
      org: DEFAULT_ORG,
      aggregatorId,
      intent: 'approve',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'approve' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('Aggregator not found');
  });

  it('POST /renew/:id with no body shows the invalid-token page', async () => {
    const { id } = await seedPendingAggregator();
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/renew/${id}`,
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /renew/:id mints a fresh token from the token org for an org-less coordinator', async () => {
    const id = `aaaaaaaa-bbbb-cccc-dddd-${String(900).padStart(12, '0')}`;
    userStore.seed([
      buildCoordinator({
        id,
        orgSlug: 'orgless-abcd',
        actorType: 'aggregator',
        type: null,
        name: 'Orgless',
        contact: { name: 'No Org', phone: '+919000000900', email: 'orgless@test.local' },
        status: 'pending',
        parentOrgId: null,
        inviteEmail: 'invited@orgless.local',
      }),
    ]);
    const created = await idp.createUser({
      email: 'orgless@test.local',
      firstName: 'No',
      lastName: 'Org',
      enabled: false,
      attributes: { aggregator_id: id, decision_made: 'pending' },
    });
    if (!created.ok) throw new Error('seed KC user failed');
    const key = new TextEncoder().encode(process.env.APPROVAL_TOKEN_SECRET);
    const expired = await new SignJWT({ intent: 'approve', org: 'org-Z' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(id)
      .setIssuer('aggregator-api')
      .setAudience('aggregator-admin')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(key);
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/renew/${id}`,
      payload: { token: expired },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('invited@orgless.local');
  });
});
