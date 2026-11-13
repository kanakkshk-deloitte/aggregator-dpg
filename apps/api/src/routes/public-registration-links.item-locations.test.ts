/**
 * Tests for the `item_locations` passthrough on
 * POST /public/v1/aggregators/:orgSlug/registrations/:slug.
 *
 * The key carries coordinates the registrant picked from the address
 * autocomplete. Three properties matter and none is visible from the response
 * body, which is identical either way:
 *
 *   - it is forwarded to signalstack's onboard call, not dropped,
 *   - it is STRIPPED from the profile payload, so it never reaches Ajv or the
 *     item_state written upstream — it is transport metadata about the profile,
 *     not a field of it,
 *   - a malformed value is rejected here rather than forwarded, because
 *     signalstack answers a bad coordinate with its own 400 that this route
 *     cannot attribute back to the offending key.
 *
 * Harness mirrors the sibling lifecycle/registration-mode suites: Postgres is
 * replaced by a minimal db stub and signalstack by the in-memory fake, spied on
 * where the assertion is about what was SENT rather than what came back.
 *
 * @module apps/api/routes/public-registration-links.item-locations.test
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
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

describe('POST /public/v1/aggregators/:orgSlug/registrations/:slug — item_locations', () => {
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

  const LOCATION = { lat: 12.9251, lng: 77.5938, label: 'Jayanagar' };

  /**
   * Submits `payload` and returns the input signalstack's onboard was called
   * with. The response body is identical whether coordinates were forwarded or
   * silently dropped, so the spy is the only place the difference is visible.
   */
  async function submitAndCaptureOnboard(payload: Record<string, unknown>) {
    const spy = vi.spyOn(signalstack, 'onboard');
    const res = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${LINK_SLUG}`,
      payload,
    });
    return { res, input: spy.mock.calls[0]?.[0] };
  }

  it('forwards picked coordinates to signalstack', async () => {
    const { res, input } = await submitAndCaptureOnboard({
      ...basePayload,
      location: 'Jayanagar, Bengaluru',
      item_locations: [LOCATION],
    });

    expect(res.statusCode).toBe(201);
    expect(input?.item_locations).toEqual([LOCATION]);
  });

  it('strips item_locations from the profile payload written upstream', async () => {
    // The guarantee: it must not appear as a profile FIELD. Leaking it into
    // item_state would store a coordinate object inside the participant's
    // profile, where no schema declares it.
    const { input } = await submitAndCaptureOnboard({
      ...basePayload,
      location: 'Jayanagar, Bengaluru',
      item_locations: [LOCATION],
    });

    expect(input?.profile).not.toHaveProperty('item_locations');
  });

  it('strips any extra keys a client sends inside a coordinate', async () => {
    // The browser widget reports parsed address `components` alongside the
    // point; the page narrows them away before submit, but an older client (or
    // a hand-rolled caller) may still send them. Zod's non-strict object drops
    // them here so signalstack only ever receives lat/lng/label — asserted
    // because signalstack validates its own body and an unexpected key there
    // would surface as an opaque upstream 400.
    const { res, input } = await submitAndCaptureOnboard({
      ...basePayload,
      phone: '+919876540008',
      email: 'extrakeys@example.com',
      item_locations: [{ ...LOCATION, components: { city: 'Bengaluru' }, bogus: 1 }],
    });

    expect(res.statusCode).toBe(201);
    expect(input?.item_locations).toEqual([LOCATION]);
  });

  it('forwards every entry of a multi-location field', async () => {
    const { res, input } = await submitAndCaptureOnboard({
      ...basePayload,
      phone: '+919876540001',
      email: 'multi@example.com',
      item_locations: [LOCATION, { lat: 28.6139, lng: 77.209, label: 'Delhi' }],
    });

    expect(res.statusCode).toBe(201);
    expect(input?.item_locations).toHaveLength(2);
  });

  it('omits the key when the submission carries no coordinates', async () => {
    // The common case — no Maps key configured, or an address typed without
    // picking a suggestion. Signals then geocodes the address text itself.
    const { res, input } = await submitAndCaptureOnboard({
      ...basePayload,
      phone: '+919876540002',
      email: 'nocoords@example.com',
      location: 'Jayanagar, Bengaluru',
    });

    expect(res.statusCode).toBe(201);
    expect(input).not.toHaveProperty('item_locations');
  });

  it('treats an explicitly empty array as "none supplied"', async () => {
    const { res, input } = await submitAndCaptureOnboard({
      ...basePayload,
      phone: '+919876540003',
      email: 'emptycoords@example.com',
      item_locations: [],
    });

    expect(res.statusCode).toBe(201);
    expect(input).not.toHaveProperty('item_locations');
  });

  it('rejects a coordinate sent as a string rather than a number', async () => {
    // Signals validates lat/lng strictly and does not coerce, so forwarding
    // this would surface as an opaque upstream 400.
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${LINK_SLUG}`,
      payload: {
        ...basePayload,
        phone: '+919876540004',
        email: 'stringcoords@example.com',
        item_locations: [{ lat: '12.9251', lng: '77.5938' }],
      },
    });

    expect(r.statusCode).toBe(400);
    expect((r.json() as { error?: { detail?: string } }).error?.detail).toContain('item_locations');
  });

  it('rejects an out-of-range latitude', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${LINK_SLUG}`,
      payload: {
        ...basePayload,
        phone: '+919876540005',
        email: 'badlat@example.com',
        item_locations: [{ lat: 91, lng: 77.5938 }],
      },
    });

    expect(r.statusCode).toBe(400);
  });

  it('rejects a non-array item_locations', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${LINK_SLUG}`,
      payload: {
        ...basePayload,
        phone: '+919876540006',
        email: 'notarray@example.com',
        item_locations: { lat: 12.9251, lng: 77.5938 },
      },
    });

    expect(r.statusCode).toBe(400);
  });

  it('rejects more coordinates than the per-submission cap allows', async () => {
    // Unauthenticated input with no schema-level maxItems behind it.
    const tooMany = Array.from({ length: 26 }, (_, i) => ({ lat: 12 + i * 0.01, lng: 77 }));
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${LINK_SLUG}`,
      payload: {
        ...basePayload,
        phone: '+919876540007',
        email: 'toomany@example.com',
        item_locations: tooMany,
      },
    });

    expect(r.statusCode).toBe(400);
  });
});
