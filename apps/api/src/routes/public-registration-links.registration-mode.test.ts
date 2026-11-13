/**
 * Tests for the per-link registration_mode contract on the public
 * registration endpoints. The link carries a `registration_mode` key
 * (`voice` / `form`); the resolved `submission_shape` (account_only /
 * account_and_profile) — sourced from network config — drives form shape.
 *
 *   GET  /public/v1/aggregators/:org/links/:slug   (resolve)
 *   POST /public/v1/aggregators/:org/registrations/:slug   (submit)
 *
 * Resolve:
 *   - surfaces `registration_mode` + resolved `submission_shape`
 *   - nulls `schema`, `schema_id`, `schema_version` when account_only
 *   - keeps full schema body for account_and_profile (regression)
 *
 * Submit (account_only shape, i.e. `voice` link):
 *   - identity-only body accepted, returns 201 with nulled lifecycle fields
 *   - body with `item_state` rejected as 400 REGISTRATION_MODE_MISMATCH
 *   - body with unknown keys rejected as 400 REGISTRATION_MODE_MISMATCH
 *   - a stray `partial` key is now an unknown key → 400 (flag removed)
 *
 * Resolve with `AGGREGATOR_ONBOARDING_ENABLED=form` (#637):
 *   - an existing voice link is untouched — the create-time allow-list must
 *     never reach this path, or every printed voice QR would break
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
import { _setSchemaLoader } from '../services/schema-loader/index.js';
import { SignalStackWriterFake } from '@aggregator-dpg/signalstack-writer/testing';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import type { ResolvedNetworkConfig } from '@aggregator-dpg/network-config/interface';
import { applyUrlRule } from '@aggregator-dpg/network-config/uri-fields';

// Hoisted so the vi.mock factory can reference it (mocks are hoisted above
// module code). Default resolves "allowed" so every existing test in this
// file is unaffected; the rate-limit test below overrides it once.
const { consumeMock } = vi.hoisted(() => ({
  consumeMock: vi.fn().mockResolvedValue({ allowed: true, count: 1, retryAfterSeconds: 0 }),
}));
vi.mock('../services/rate-limiter/index.js', () => ({ consume: consumeMock }));

const AGG_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID = 'org-signalstack-1';
const ORG_SLUG = 'acme';
const LINK_ID_AO = '22222222-2222-2222-2222-222222222222';
const LINK_ID_FULL = '33333333-3333-3333-3333-333333333333';
const SLUG_AO = 'walk-in-account-only';
const SLUG_FULL = 'walk-in-full';
const SUBMISSION_ID = '44444444-4444-4444-4444-444444444444';

/** Two-link stub indexed by slug. */
class TwoLinkStore extends RegistrationLinksStoreBase {
  constructor(
    private readonly accountOnly: RegistrationLink,
    private readonly full: RegistrationLink,
  ) {
    super();
  }
  async findByOrgAndSlug(
    orgSlug: string,
    slug: string,
  ): Promise<StoreResult<RegistrationLink | null>> {
    if (orgSlug !== ORG_SLUG) return { ok: true, value: null };
    if (slug === SLUG_AO) return { ok: true, value: this.accountOnly };
    if (slug === SLUG_FULL) return { ok: true, value: this.full };
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

function buildFakeDb(submissionId: string): unknown {
  const tx = {
    insert() {
      return {
        values() {
          return {
            async returning() {
              return [{ id: submissionId }];
            },
          };
        },
      };
    },
    // The route corrects the stored outcome after the signalstack push (#780).
    update() {
      return { set: () => ({ async where() {} }) };
    },
  };
  return {
    async transaction(cb: (tx: unknown) => Promise<unknown>) {
      return cb(tx);
    },
  };
}

const baseLink = {
  aggregatorId: AGG_ID,
  domain: 'seeker' as const,
  context: {},
  qrObjectKey: null,
  status: 'live' as const,
  expiresAt: null,
  createdBy: 'system',
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

async function bootApp(): Promise<{
  app: FastifyInstance;
  signalstack: SignalStackWriterFake;
}> {
  consumeMock.mockClear();
  consumeMock.mockResolvedValue({ allowed: true, count: 1, retryAfterSeconds: 0 });
  process.env.SIGNALSTACK_BASE_URL = 'http://stub-signalstack';
  process.env.SIGNALSTACK_ADMIN_KEY = 'stub-key';
  process.env.SIGNALSTACK_ACTING_ORG_ID = 'org_platform';
  process.env.SIGNALSTACK_ITEM_NETWORK = 'blue_dot';
  _setNetworkConfig(buildBlueDotConfig());

  const aggStore = new UserStoreFake();
  aggStore.seed([
    buildCoordinator({
      id: AGG_ID,
      orgSlug: ORG_SLUG,
      name: 'Acme',
      status: 'active',
      signalstackOrgId: ORG_ID,
    }),
  ]);
  _setUserStore(aggStore);

  const signalstack = new SignalStackWriterFake();
  _setSignalStackWriter(signalstack);

  const aoLink: RegistrationLink = {
    ...baseLink,
    id: LINK_ID_AO,
    slug: SLUG_AO,
    registrationMode: 'voice',
  };
  const fullLink: RegistrationLink = {
    ...baseLink,
    id: LINK_ID_FULL,
    slug: SLUG_FULL,
    registrationMode: 'form',
  };
  _setRegistrationLinksStore(new TwoLinkStore(aoLink, fullLink));
  _setDbClients(null, buildFakeDb(SUBMISSION_ID) as never);

  const app = await buildApp();
  return { app, signalstack };
}

async function teardown(app: FastifyInstance | undefined): Promise<void> {
  await app?.close();
  _setSignalStackWriter(null);
  _setUserStore(null);
  _setRegistrationLinksStore(null);
  _setNetworkConfig(null);
  _setDbClients(null, null);
  _setSchemaLoader(null);
}

describe('GET /public/v1/aggregators/:org/links/:slug — registration_mode (resolve)', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    ({ app } = await bootApp());
  });
  afterEach(() => teardown(app));

  it('surfaces voice mode → account_only shape and nulls schema fields', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/public/v1/aggregators/${ORG_SLUG}/links/${SLUG_AO}`,
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.registration_mode).toBe('voice');
    expect(body.submission_shape).toBe('account_only');
    expect(body.public_hint_i18n_key).toBe('registration_mode.voice.hint');
    expect(body.schema).toBeNull();
    expect(body.schema_id).toBeNull();
    expect(body.schema_version).toBeNull();
  });

  it('surfaces form mode → account_and_profile shape and includes schema body', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/public/v1/aggregators/${ORG_SLUG}/links/${SLUG_FULL}`,
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.registration_mode).toBe('form');
    expect(body.submission_shape).toBe('account_and_profile');
    expect(body.public_hint_i18n_key).toBeNull();
    expect(body.schema).not.toBeNull();
    expect(body.schema_id).toBe('participant-seeker');
    expect(body.schema_version).toBe('v1');
  });
});

describe('GET /public/v1/aggregators/:org/links/:slug — AGGREGATOR_ONBOARDING_ENABLED (#637)', () => {
  // The most important regression guard in #637. The env var narrows which
  // modes a *new* link may be created in; it must never touch the resolve
  // path, or every voice QR already printed and handed out would resolve as
  // a full-profile link (wrong shape, wrong hint, and a Signals CTA it was
  // built without). `public-registration-links.ts` reads `getNetworkConfig()`
  // directly — unfiltered — and this pins that.
  let app: FastifyInstance;
  const original = process.env.AGGREGATOR_ONBOARDING_ENABLED;

  beforeEach(async () => {
    process.env.AGGREGATOR_ONBOARDING_ENABLED = 'form';
    ({ app } = await bootApp());
  });
  afterEach(async () => {
    await teardown(app);
    if (original === undefined) delete process.env.AGGREGATOR_ONBOARDING_ENABLED;
    else process.env.AGGREGATOR_ONBOARDING_ENABLED = original;
  });

  it('still resolves an existing voice link as account_only with its hint', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/public/v1/aggregators/${ORG_SLUG}/links/${SLUG_AO}`,
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.registration_mode).toBe('voice');
    expect(body.submission_shape).toBe('account_only');
    expect(body.public_hint_i18n_key).toBe('registration_mode.voice.hint');
    expect(body.schema).toBeNull();
  });

  it('still accepts a submission on that voice link', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${SLUG_AO}`,
      payload: { name: 'Withheld Mode', phone: '+919812345670' },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().submission_shape).toBe('account_only');
  });

  it('leaves the form link untouched too', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/public/v1/aggregators/${ORG_SLUG}/links/${SLUG_FULL}`,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().submission_shape).toBe('account_and_profile');
  });
});

describe('POST /public/v1/aggregators/:org/registrations/:slug — account_only (voice)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    ({ app } = await bootApp());
  });
  afterEach(() => teardown(app));

  it('accepts identity-only body and returns 201 with null lifecycle fields', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${SLUG_AO}`,
      payload: {
        name: 'A. User',
        phone: '+919999999999',
        consent_terms: true,
        consent_privacy: true,
      },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.lifecycle_status).toBeNull();
    expect(body.registration_mode).toBe('voice');
    expect(body.submission_shape).toBe('account_only');
  });

  it('accepts an account_only submit with email identity (201)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${SLUG_AO}`,
      payload: {
        name: 'A. User',
        email: 'u@example.com',
        consent_terms: true,
        consent_privacy: true,
      },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().submission_shape).toBe('account_only');
  });

  it('re-submitting the same phone is an idempotent 201, not a 409 dedup', async () => {
    const payload = {
      name: 'A. User',
      phone: '+919999900001',
      consent_terms: true,
      consent_privacy: true,
    };
    const first = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${SLUG_AO}`,
      payload,
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().outcome).toBe('passed');

    // Second submit hits the local participants dedup (writeOutcome=skipped),
    // but signals reports the same own user (owned_elsewhere=false) — so the
    // response must stay a 201 success, not a 409 "already registered".
    const second = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${SLUG_AO}`,
      payload,
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().outcome).toBe('passed');
    expect(second.json().owned_elsewhere).toBe(false);
  });

  it('rejects body containing item_state with 400 REGISTRATION_MODE_MISMATCH', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${SLUG_AO}`,
      payload: {
        name: 'A. User',
        phone: '+919999999999',
        consent_terms: true,
        consent_privacy: true,
        item_state: { profile_field: 'x' },
      },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('REGISTRATION_MODE_MISMATCH');
  });

  it('rejects body with unknown keys', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${SLUG_AO}`,
      payload: {
        name: 'A. User',
        phone: '+919999999999',
        consent_terms: true,
        consent_privacy: true,
        wat: 'stray',
      },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('REGISTRATION_MODE_MISMATCH');
  });

  it('rejects a stray `partial` key (flag removed; now an unknown field)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${SLUG_AO}`,
      payload: {
        name: 'A. User',
        phone: '+919999999999',
        consent_terms: true,
        consent_privacy: true,
        partial: true,
      },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('REGISTRATION_MODE_MISMATCH');
  });

  it('rejects missing identity fields (no phone or email)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${SLUG_AO}`,
      payload: {
        name: 'A. User',
        consent_terms: true,
        consent_privacy: true,
      },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('SCHEMA_VALIDATION');
  });
});

describe('link-not-live / link-lookup failure branches', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    ({ app } = await bootApp());
  });
  afterEach(() => teardown(app));

  it('503s (DB_UNAVAILABLE) when the registration-links store fails on GET resolve', async () => {
    _setRegistrationLinksStore(
      new (class extends RegistrationLinksStoreBase {
        async findByOrgAndSlug(): Promise<StoreResult<RegistrationLink | null>> {
          return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'store down' } };
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
      })(),
    );
    const r = await app.inject({
      method: 'GET',
      url: `/public/v1/aggregators/${ORG_SLUG}/links/${SLUG_AO}`,
    });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('DB_UNAVAILABLE');
  });

  it('410s (LINK_NOT_LIVE) when the link is retired', async () => {
    _setRegistrationLinksStore(
      new TwoLinkStore(
        {
          ...baseLink,
          id: LINK_ID_AO,
          slug: SLUG_AO,
          registrationMode: 'voice',
          status: 'retired',
        },
        { ...baseLink, id: LINK_ID_FULL, slug: SLUG_FULL, registrationMode: 'form' },
      ),
    );
    const r = await app.inject({
      method: 'GET',
      url: `/public/v1/aggregators/${ORG_SLUG}/links/${SLUG_AO}`,
    });
    expect(r.statusCode).toBe(410);
    expect(r.json().error.code).toBe('LINK_NOT_LIVE');
    expect(r.json().error.detail).toContain('retired');
  });

  it('410s (LINK_NOT_LIVE) when the link has expired', async () => {
    _setRegistrationLinksStore(
      new TwoLinkStore(
        {
          ...baseLink,
          id: LINK_ID_AO,
          slug: SLUG_AO,
          registrationMode: 'voice',
          expiresAt: new Date('2020-01-01T00:00:00Z'),
        },
        { ...baseLink, id: LINK_ID_FULL, slug: SLUG_FULL, registrationMode: 'form' },
      ),
    );
    const r = await app.inject({
      method: 'GET',
      url: `/public/v1/aggregators/${ORG_SLUG}/links/${SLUG_AO}`,
    });
    expect(r.statusCode).toBe(410);
    expect(r.json().error.code).toBe('LINK_NOT_LIVE');
    expect(r.json().error.detail).toContain('expired');
  });

  it('404s when the link domain is not declared in the active network config (GET resolve)', async () => {
    const cfg = buildBlueDotConfig();
    const { seeker: _seeker, ...rest } = cfg.domains;
    _setNetworkConfig({ ...cfg, domains: rest } as ResolvedNetworkConfig);
    const r = await app.inject({
      method: 'GET',
      url: `/public/v1/aggregators/${ORG_SLUG}/links/${SLUG_FULL}`,
    });
    expect(r.statusCode).toBe(404);
  });

  it('404s when the link domain is not declared in the active network config (POST submit)', async () => {
    const cfg = buildBlueDotConfig();
    const { seeker: _seeker, ...rest } = cfg.domains;
    _setNetworkConfig({ ...cfg, domains: rest } as ResolvedNetworkConfig);
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${SLUG_FULL}`,
      payload: { name: 'X', phone: '+919999999999' },
    });
    expect(r.statusCode).toBe(404);
  });
});

describe('rate limiting on POST submit', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    ({ app } = await bootApp());
  });
  afterEach(() => teardown(app));

  it('429s with Retry-After when the per-link rate limit trips', async () => {
    consumeMock.mockResolvedValueOnce({ allowed: false, count: 21, retryAfterSeconds: 7 });
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${SLUG_AO}`,
      payload: {
        name: 'A. User',
        phone: '+919999999999',
        consent_terms: true,
        consent_privacy: true,
      },
    });
    expect(r.statusCode).toBe(429);
    expect(r.headers['retry-after']).toBe('7');
    expect(r.json().error.code).toBe('RATE_LIMITED');
  });
});

describe('schema validation failure branches (account_and_profile)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    ({ app } = await bootApp());
  });
  afterEach(() => teardown(app));

  it('500s (INTERNAL) when the schema loader cannot resolve a validator', async () => {
    _setSchemaLoader({
      getSchema: async () => ({
        success: false,
        error: { code: 'SCHEMA_NOT_FOUND', message: 'no schema' },
      }),
      getValidator: async () => ({
        success: false,
        error: { code: 'SCHEMA_NOT_FOUND', message: 'no schema' },
      }),
    } as unknown as Parameters<typeof _setSchemaLoader>[0]);
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${SLUG_FULL}`,
      payload: {
        name: 'A. User',
        phone: '+919999999999',
        consent_terms: true,
        consent_privacy: true,
        consent_profile: true,
        year_of_birth: 1990,
      },
    });
    expect(r.statusCode).toBe(500);
    expect(r.json().error.code).toBe('INTERNAL');
  });

  it('400s (SCHEMA_VALIDATION) on a real (non-required) Ajv violation, e.g. wrong type', async () => {
    const cfg = buildBlueDotConfig();
    _setNetworkConfig({
      ...cfg,
      domains: {
        ...cfg.domains,
        seeker: {
          ...cfg.domains.seeker,
          schema: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              phone: { type: 'string' },
              years_experience: { type: 'integer', minimum: 0 },
            },
          },
        },
      },
    } as ResolvedNetworkConfig);
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${SLUG_FULL}`,
      payload: {
        name: 'A. User',
        phone: '+919999999999',
        years_experience: 'not-a-number',
        consent_terms: true,
        consent_privacy: true,
        consent_profile: true,
        year_of_birth: 1990,
      },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('SCHEMA_VALIDATION');
  });

  describe('link fields use the Signals URL rule (#904)', () => {
    // The schema as the network-config loader hands it out: both link
    // declarations rewritten by `applyUrlRule`.
    const submit = async (
      fields: Record<string, unknown>,
      extraProperties: Record<string, unknown> = {},
    ) => {
      const cfg = buildBlueDotConfig();
      _setNetworkConfig({
        ...cfg,
        domains: {
          ...cfg.domains,
          seeker: {
            ...cfg.domains.seeker,
            schema: applyUrlRule({
              type: 'object',
              properties: {
                name: { type: 'string' },
                phone: { type: 'string' },
                website: { type: 'string', title: 'Website', 'x-uri': true },
                catalog_url: { type: 'string', title: 'Catalog URL', format: 'uri' },
                ...extraProperties,
              },
            }),
          },
        },
      } as ResolvedNetworkConfig);
      return app.inject({
        method: 'POST',
        url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${SLUG_FULL}`,
        payload: {
          name: 'A. User',
          phone: '+919999999999',
          consent_terms: true,
          consent_privacy: true,
          consent_profile: true,
          year_of_birth: 1990,
          ...fields,
        },
      });
    };

    it('accepts a web address with no scheme on both kinds of link field', async () => {
      const r = await submit({ website: 'www.example.org', catalog_url: 'example.org/list' });
      expect(r.statusCode).toBe(201);
    });

    it('rejects a value that is not a web address, naming the field in the detail', async () => {
      const r = await submit({ website: 'NA' });
      expect(r.statusCode).toBe(400);
      const error = r.json().error;
      expect(error.code).toBe('SCHEMA_VALIDATION');
      expect(error.detail).toBe('Website: Please enter a valid web address.');
      expect(error.fields.field_errors).toEqual({ website: 'Please enter a valid web address.' });
    });

    it('keeps a field whose name is an Object.prototype member in field_errors', async () => {
      const r = await submit(
        { constructor: 'NA' },
        { constructor: { type: 'string', title: 'Builder site', 'x-uri': true } },
      );
      expect(r.statusCode).toBe(400);
      expect(r.json().error.fields.field_errors).toEqual({
        constructor: 'Please enter a valid web address.',
      });
    });
  });

  describe('conditional requirement (if/then), e.g. category licensed → licence_number + licence_type', () => {
    // Signals relaxes only TOP-LEVEL required fields (a partial profile lands
    // as a draft); a requirement inside an if/then branch it enforces. So the
    // link route must block it too — naming the missing fields, never Ajv's
    // bare `if` summary ("must match \"then\" schema").
    const withConditionalSchema = () => {
      const cfg = buildBlueDotConfig();
      _setNetworkConfig({
        ...cfg,
        domains: {
          ...cfg.domains,
          seeker: {
            ...cfg.domains.seeker,
            schema: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                phone: { type: 'string' },
                category: { type: 'string', enum: ['individual', 'licensed'] },
                licence_number: { type: 'string', pattern: '^$|^[0-9]+$' },
                licence_type: { type: 'string', enum: ['Clinical', 'Other'] },
              },
              required: ['name', 'category'],
              allOf: [
                {
                  if: { properties: { category: { const: 'licensed' } }, required: ['category'] },
                  then: { required: ['licence_number', 'licence_type'] },
                },
              ],
            },
          },
        },
      } as ResolvedNetworkConfig);
    };
    const submit = (extra: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${SLUG_FULL}`,
        payload: {
          name: 'A. User',
          phone: '+919999999999',
          consent_terms: true,
          consent_privacy: true,
          consent_profile: true,
          year_of_birth: 1990,
          ...extra,
        },
      });

    it('400s naming each conditionally required field that is missing', async () => {
      withConditionalSchema();
      const r = await submit({ category: 'licensed' });
      expect(r.statusCode).toBe(400);
      const issues = r.json().error.fields.issues as Array<{
        keyword: string;
        params?: { missingProperty?: string };
      }>;
      expect(issues.map((i) => i.params?.missingProperty).sort()).toEqual([
        'licence_number',
        'licence_type',
      ]);
      expect(issues.some((i) => i.keyword === 'if')).toBe(false);
    });

    it('does not 400 when the conditional fields are filled, or the condition does not apply', async () => {
      withConditionalSchema();
      const filled = await submit({
        category: 'licensed',
        licence_number: '123',
        licence_type: 'Other',
      });
      expect(filled.json().error?.code).not.toBe('SCHEMA_VALIDATION');
      const ngo = await submit({ category: 'individual' });
      expect(ngo.json().error?.code).not.toBe('SCHEMA_VALIDATION');
    });
  });

  it('400s (SCHEMA_VALIDATION) when name/phone/email are all empty after stripping blank cells', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${SLUG_FULL}`,
      payload: {
        name: '   ',
        phone: '',
        consent_terms: true,
        consent_privacy: true,
        consent_profile: true,
        year_of_birth: 1990,
      },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('SCHEMA_VALIDATION');
    expect(r.json().error.fields?.missing).toContain('name');
  });

  it('400s (INVALID_PHONE) when the phone value fails E.164 normalisation', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${SLUG_FULL}`,
      payload: {
        name: 'A. User',
        phone: '123',
        consent_terms: true,
        consent_privacy: true,
        consent_profile: true,
        year_of_birth: 1990,
      },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('INVALID_PHONE');
  });

  it('accepts a numeric-string year_of_birth (coerced) and still succeeds', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${SLUG_FULL}`,
      payload: {
        name: 'A. User',
        phone: '+919999911111',
        consent_terms: true,
        consent_privacy: true,
        consent_profile: true,
        year_of_birth: '1990',
      },
    });
    expect(r.statusCode).toBe(201);
  });

  it('strips blank optional cells before schema validation (whitespace, empty array)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/${ORG_SLUG}/registrations/${SLUG_FULL}`,
      payload: {
        name: 'A. User',
        phone: '+919999922222',
        notes: '   ',
        tags: [],
        consent_terms: true,
        consent_privacy: true,
        consent_profile: true,
        year_of_birth: 1990,
      },
    });
    expect(r.statusCode).toBe(201);
  });
});
