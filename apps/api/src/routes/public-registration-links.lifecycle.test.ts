/**
 * Tests for POST /public/v1/aggregators/:orgSlug/registrations/:slug —
 * lifecycle-aware contract added in Task 7. Verifies that the handler:
 *
 *   - forwards `submit_mode` (derived from the optional `partial` envelope
 *     flag) into `SignalStackWriter.onboard`,
 *   - surfaces `lifecycle_status` and `owned_elsewhere`
 *     on the route response,
 *   - returns null lifecycle fields on `account_only` submits (no item),
 *   - flags `owned_elsewhere: true` (with `outcome: skipped`, 409) when
 *     signals reports a foreign user.
 *
 * Bypasses the real Postgres dependency by injecting a minimal db stub via
 * `_setDbClients`; the only operation the route runs against `tx` is the
 * `link_submissions` insert + returning(id) chain modelled here.
 *
 * @module apps/api/routes/public-registration-links.lifecycle.test
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { UserStoreFake, _setUserStore, buildCoordinator } from '../services/user-store/index.js';
import { _setSignalStackWriter } from '../services/signalstack.js';
import { _setNetworkConfig } from '../services/network-config.js';
import { _setDbClients } from '../db/client.js';
import {
  _setRegistrationLinksStore,
  RegistrationLinksStoreBase,
  type RegistrationLink,
  type StoreResult,
} from '../services/registration-links-store/index.js';
import { SignalStackWriterFake } from '@aggregator-dpg/signalstack-writer/testing';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import { UpstreamError } from '@aggregator-dpg/shared-primitives/errors';
import { err } from '@aggregator-dpg/shared-primitives/result';

const AGG_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID = 'org-signalstack-1';
const ORG_SLUG = 'acme';
const LINK_ID = '22222222-2222-2222-2222-222222222222';
const LINK_SLUG = 'walk-in-2026';

/**
 * Stub registration-links store with only `findByOrgAndSlug` implemented —
 * the public submit handler does not call the other methods on this path.
 * Returning a single seeded `live` link mirrors what the postgres impl
 * would return for the (orgSlug, slug) pair the tests submit against.
 */
class StubRegistrationLinksStore extends RegistrationLinksStoreBase {
  constructor(private readonly link: RegistrationLink) {
    super();
  }
  async findByOrgAndSlug(
    orgSlug: string,
    slug: string,
  ): Promise<StoreResult<RegistrationLink | null>> {
    if (orgSlug === ORG_SLUG && slug === LINK_SLUG) {
      return { ok: true, value: this.link };
    }
    return { ok: true, value: null };
  }
  async create(): Promise<StoreResult<RegistrationLink>> {
    return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'stub' } };
  }
  async findById(): Promise<StoreResult<RegistrationLink | null>> {
    return { ok: true, value: null };
  }
  async findBySlug(): Promise<StoreResult<RegistrationLink | null>> {
    return { ok: true, value: null };
  }
  async updateDraft(): Promise<StoreResult<RegistrationLink>> {
    return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'stub' } };
  }
  async list(): Promise<StoreResult<{ rows: RegistrationLink[]; total: number }>> {
    return { ok: true, value: { rows: [], total: 0 } };
  }
  async updateStatus(): Promise<StoreResult<RegistrationLink>> {
    return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'stub' } };
  }
}

/**
 * Builds a minimal `tx`/`db` shape the route exercises: the
 * `tx.insert(linkSubmissions).values(...).returning({ id })` chain, shortcut to
 * a deterministic id so the response carries a stable submission uuid, and the
 * `tx.update(...).set(...).where(...)` the route runs when the signalstack push
 * corrects the local writer's outcome (#780).
 *
 * `storedOutcome` exposes what the row would actually hold at commit — the
 * response alone cannot show that, and a row disagreeing with the response is
 * precisely the bug the correction exists to prevent.
 */
function buildFakeDb(submissionId: string): {
  db: unknown;
  storedOutcome: () => string | undefined;
} {
  let stored: string | undefined;
  const tx = {
    insert() {
      return {
        values(row: { outcome?: string }) {
          stored = row.outcome;
          return {
            async returning() {
              return [{ id: submissionId }];
            },
          };
        },
      };
    },
    update() {
      return {
        set(patch: { outcome?: string }) {
          return {
            async where() {
              stored = patch.outcome;
            },
          };
        },
      };
    },
  };
  return {
    db: {
      async transaction(cb: (tx: unknown) => Promise<unknown>) {
        return cb(tx);
      },
    },
    storedOutcome: () => stored,
  };
}

const SUBMISSION_ID = '33333333-3333-3333-3333-333333333333';

describe('POST /public/v1/aggregators/:orgSlug/registrations/:slug — lifecycle', () => {
  let fakeDb: ReturnType<typeof buildFakeDb>;
  let app: FastifyInstance;
  let signalstack: SignalStackWriterFake;
  let userStore: UserStoreFake;

  beforeEach(async () => {
    // Treat signalstack as enabled so getSignalStackWriter returns our fake.
    process.env.SIGNALSTACK_BASE_URL = 'http://stub-signalstack';
    process.env.SIGNALSTACK_ADMIN_KEY = 'stub-key';
    process.env.SIGNALSTACK_ACTING_ORG_ID = 'org_platform';
    process.env.SIGNALSTACK_ITEM_NETWORK = 'blue_dot';

    // Coordinator seeded with a signalstackOrgId so the route doesn't bail
    // with SIGNALSTACK_ORG_NOT_REGISTERED before it gets to onboard().
    userStore = new UserStoreFake();
    userStore.seed([
      buildCoordinator({
        id: AGG_ID,
        orgSlug: ORG_SLUG,
        name: 'Acme Aggregator',
        status: 'active',
        signalstackOrgId: ORG_ID,
      }),
    ]);
    _setUserStore(userStore);

    signalstack = new SignalStackWriterFake();
    _setSignalStackWriter(signalstack);

    _setNetworkConfig(buildBlueDotConfig());

    const liveLink: RegistrationLink = {
      id: LINK_ID,
      aggregatorId: AGG_ID,
      slug: LINK_SLUG,
      domain: 'seeker',
      context: {},
      registrationMode: 'form',
      qrObjectKey: null,
      status: 'live',
      expiresAt: null,
      createdBy: 'system',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    };
    _setRegistrationLinksStore(new StubRegistrationLinksStore(liveLink));

    // Minimal db stub — exposes only what the public-submit handler calls
    // on the transaction handle.
    fakeDb = buildFakeDb(SUBMISSION_ID);
    _setDbClients(null, fakeDb.db as never);

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    _setUserStore(null);
    _setSignalStackWriter(null);
    _setNetworkConfig(null);
    _setRegistrationLinksStore(null);
    _setDbClients(null, null);
  });

  const basePayload = {
    name: 'Asha Kumari',
    phone: '+919876543210',
    email: 'asha@example.com',
    // Consent is now required on every registration-link submit (#522). The
    // account_and_profile shape additionally requires profile-creation consent
    // and a year of birth (age is derived + sent with the compliance push).
    consent_terms: true,
    consent_privacy: true,
    consent_profile: true,
    year_of_birth: 1990,
  };

  it('returns lifecycle_status="live" on default classification', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${LINK_SLUG}`,
      payload: basePayload,
    });
    expect(r.statusCode).toBe(201);
    const body = r.json() as {
      outcome: string;
      lifecycle_status: string | null;
      owned_elsewhere: boolean;
    };
    expect(body.outcome).toBe('passed');
    expect(body.lifecycle_status).toBe('live');
    expect(body.owned_elsewhere).toBe(false);
  });

  it('returns lifecycle_status="draft" when signals classifies as draft', async () => {
    signalstack.setNextClassification({ lifecycle_status: 'draft' });
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${LINK_SLUG}`,
      payload: { ...basePayload, phone: '+919876543299', email: 'draft@example.com' },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json() as {
      lifecycle_status: string | null;
    };
    expect(body.lifecycle_status).toBe('draft');
  });

  it('ignores a stray `partial` flag on a form link (still creates an item)', async () => {
    // The legacy per-submit `partial` opt-in was removed — form (account_and_
    // profile) links always submit with_item and let signals classify. A
    // stray `partial: true` from an old client is stripped, not honoured, so
    // the lifecycle status is still populated (not nulled).
    signalstack.setNextClassification({ lifecycle_status: 'draft' });
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${LINK_SLUG}`,
      payload: {
        name: 'Partial User',
        phone: '+919876500000',
        email: 'partial@example.com',
        partial: true,
        consent_terms: true,
        consent_privacy: true,
        consent_profile: true,
        year_of_birth: 1990,
      },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json() as {
      lifecycle_status: string | null;
      owned_elsewhere: boolean;
    };
    expect(body.lifecycle_status).toBe('draft');
    expect(body.owned_elsewhere).toBe(false);
  });

  it('flags owned_elsewhere=true when signals reports a foreign user', async () => {
    signalstack.seedForeignUser({ email: 'shared@x.com' });
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${LINK_SLUG}`,
      payload: { ...basePayload, phone: '+919876511111', email: 'shared@x.com' },
    });
    // Existing-user path returns 409 with outcome=skipped per the route's
    // legacy convention; lifecycle fields are null because signals creates
    // no item for a foreign-owned identity.
    expect(r.statusCode).toBe(409);
    const body = r.json() as {
      outcome: string;
      owned_elsewhere: boolean;
      lifecycle_status: string | null;
    };
    expect(body.outcome).toBe('skipped');
    expect(body.owned_elsewhere).toBe(true);
    expect(body.lifecycle_status).toBeNull();
  });

  it('a repeat submission from the same participant passes, not skipped (#780)', async () => {
    // Signals inserts a NEW profile on every onboard call without an `item_id`,
    // so a repeat submission really did create a profile and must report
    // `passed`. This was originally a #780 fix against the local `participants`
    // mirror, which reported `skipped` while the profile was created anyway;
    // that mirror has since been removed, and this test pins the behaviour so a
    // future local dedup cannot silently reintroduce the wrong answer.
    const payload = { ...basePayload, phone: '+919876533333', email: 'repeat@x.com' };
    const first = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${LINK_SLUG}`,
      payload,
    });
    expect(first.statusCode).toBe(201);
    expect((first.json() as { outcome: string }).outcome).toBe('passed');

    const second = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${LINK_SLUG}`,
      payload,
    });
    expect(second.statusCode).toBe(201);
    const body = second.json() as { outcome: string; owned_elsewhere: boolean };
    expect(body.outcome).toBe('passed');
    // Tenant isolation is untouched — only the same-aggregator repeat changed.
    expect(body.owned_elsewhere).toBe(false);
    // And the STORED row agrees. The insert runs before the push, carrying the
    // local writer's `skipped`; without the in-transaction correction the table
    // would record a duplicate for a submission that created a profile.
    expect(fakeDb.storedOutcome()).toBe('passed');
  });

  it('creates a minor without consent — age + compliance omitted (#522 §4.4)', async () => {
    // A minor's year of birth → derived age <= 18. The API must NOT send a
    // top-level age or a compliance block (which would trip Signals'
    // U18_NOT_ALLOWED); Signals then creates the account with no consent. No
    // consent fields are sent here either, proving they are not required.
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${LINK_SLUG}`,
      payload: {
        name: 'Minor User',
        phone: '+919876500015',
        email: 'minor@example.com',
        year_of_birth: 2015,
      },
    });
    expect(r.statusCode).toBe(201);
    expect((r.json() as { outcome: string }).outcome).toBe('passed');
  });

  it('rejects a submit with 400 CONSENT_REQUIRED when consent is not given (#522)', async () => {
    // #613: consent is only enforced when the link's domain gates go-live on
    // `consent_required`. Configure the domains as consent-gated so the #522
    // no-consent rejection applies.
    const consentGated = buildBlueDotConfig();
    Object.values(consentGated.domains).forEach((d) => {
      d.goLiveRequired = ['schema_required', 'consent_required'];
    });
    _setNetworkConfig(consentGated);
    const { consent_terms: _t, consent_privacy: _p, ...noConsent } = basePayload;
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${LINK_SLUG}`,
      payload: { ...noConsent, phone: '+919876500042', email: 'noconsent@example.com' },
    });
    expect(r.statusCode).toBe(400);
    expect((r.json() as { error?: { code?: string } }).error?.code).toBe('CONSENT_REQUIRED');
  });

  it('404s when the live link points at an aggregator that no longer exists', async () => {
    _setUserStore(new UserStoreFake());
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${LINK_SLUG}`,
      payload: { ...basePayload, phone: '+919876500099', email: 'noagg@example.com' },
    });
    expect(r.statusCode).toBe(404);
    expect((r.json() as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  it('503s (DB_UNAVAILABLE) when the aggregator lookup fails', async () => {
    userStore.findById = async () => ({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'db down' },
    });
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${LINK_SLUG}`,
      payload: { ...basePayload, phone: '+919876500098', email: 'lookupfail@example.com' },
    });
    expect(r.statusCode).toBe(503);
    expect((r.json() as { error: { code: string } }).error.code).toBe('DB_UNAVAILABLE');
  });

  it('503s (SIGNALSTACK_ORG_NOT_REGISTERED) when the aggregator has no signalstack org id on file', async () => {
    userStore.seed([
      buildCoordinator({
        id: AGG_ID,
        orgSlug: ORG_SLUG,
        name: 'Acme Aggregator',
        status: 'active',
        signalstackOrgId: null,
      }),
    ]);
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${LINK_SLUG}`,
      payload: { ...basePayload, phone: '+919876500097', email: 'noorg@example.com' },
    });
    expect(r.statusCode).toBe(503);
    expect((r.json() as { error: { code: string } }).error.code).toBe(
      'SIGNALSTACK_ORG_NOT_REGISTERED',
    );
  });

  it('502s (SIGNALSTACK_PUSH_FAILED) when the signalstack push fails for a non-U18 reason', async () => {
    signalstack.onboard = async () =>
      err(
        new UpstreamError('signalstack onboard returned 500', { code: 'SIGNALSTACK_SERVER_ERROR' }),
      );
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${LINK_SLUG}`,
      payload: { ...basePayload, phone: '+919876500095', email: 'pushfail@example.com' },
    });
    expect(r.statusCode).toBe(502);
    expect((r.json() as { error: { code: string } }).error.code).toBe('SIGNALSTACK_PUSH_FAILED');
  });

  it("400s with Signals' per-field messages when Signals rejects the profile data (#904)", async () => {
    signalstack.onboard = async () =>
      err(
        new UpstreamError(
          'signalstack onboard returned 400: INVALID_ITEM_STATE: Invalid item_state: website: Please enter a valid web address.',
          {
            code: 'SIGNALSTACK_BAD_REQUEST',
            details: {
              status: 400,
              upstreamCode: 'INVALID_ITEM_STATE',
              signalsMessage: 'Invalid item_state: website: Please enter a valid web address.',
              signalsFields: { website: 'Please enter a valid web address.' },
            },
          },
        ),
      );
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${LINK_SLUG}`,
      payload: { ...basePayload, phone: '+919876500093', email: 'badsite@example.com' },
    });
    expect(r.statusCode).toBe(400);
    const error = (
      r.json() as { error: { code: string; detail: string; fields: Record<string, unknown> } }
    ).error;
    expect(error.code).toBe('SCHEMA_VALIDATION');
    expect(error.detail).toBe('website: Please enter a valid web address.');
    expect(error.fields['field_errors']).toEqual({ website: 'Please enter a valid web address.' });
    expect(error.fields['upstream_code']).toBe('INVALID_ITEM_STATE');
  });

  it('400s (U18_REGISTRATION_REDIRECT) when signalstack maps the push to U18_NOT_ALLOWED', async () => {
    // Defensive belt-and-braces mapping: the route's own U18 gate already
    // strips age/compliance for a derived-minor submit, so this exercises
    // the redirect mapping directly rather than relying on a bypass of the
    // client-side gate (which the server-side derivation makes unreachable
    // through the public HTTP surface).
    signalstack.onboard = async () =>
      err(
        new UpstreamError(
          'signalstack onboard returned 400: U18_NOT_ALLOWED: under-18 users cannot be onboarded via this API; use the portal',
          { code: 'SIGNALSTACK_BAD_REQUEST' },
        ),
      );
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${LINK_SLUG}`,
      payload: { ...basePayload, phone: '+919876500094', email: 'u18@example.com' },
    });
    expect(r.statusCode).toBe(400);
    expect((r.json() as { error: { code: string } }).error.code).toBe('U18_REGISTRATION_REDIRECT');
  });

  it('surfaces the bare signals user-facing sentence on a profile-limit push failure', async () => {
    signalstack.onboard = async () =>
      err(
        new UpstreamError(
          'signalstack onboard returned 409: PROFILE_LIMIT_REACHED: too many profiles',
          {
            code: 'SIGNALSTACK_PROFILE_LIMIT_REACHED',
            details: { signalsMessage: 'You have reached the maximum number of profiles.' },
          },
        ),
      );
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${LINK_SLUG}`,
      payload: { ...basePayload, phone: '+919876500093', email: 'limit@example.com' },
    });
    expect(r.statusCode).toBe(502);
    const body = r.json() as { error: { code: string; detail: string } };
    expect(body.error.code).toBe('SIGNALSTACK_PUSH_FAILED');
    expect(body.error.detail).toBe('You have reached the maximum number of profiles.');
  });

  it('404s when the stored link is in draft status (not just when the row is missing)', async () => {
    _setRegistrationLinksStore(
      new StubRegistrationLinksStore({
        id: LINK_ID,
        aggregatorId: AGG_ID,
        slug: LINK_SLUG,
        domain: 'seeker',
        context: {},
        registrationMode: 'form',
        qrObjectKey: null,
        status: 'draft',
        expiresAt: null,
        createdBy: 'system',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      }),
    );
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${LINK_SLUG}`,
      payload: { ...basePayload, phone: '+919876500092', email: 'draftlink@example.com' },
    });
    expect(r.statusCode).toBe(404);
    expect((r.json() as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });
});
