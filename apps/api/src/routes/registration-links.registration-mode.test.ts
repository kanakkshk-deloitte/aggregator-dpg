/**
 * Tests for the admin POST /v1/links/create + PATCH /v1/links/:id handlers'
 * behaviour around the per-link `registration_mode` key:
 *
 *   - create defaults the field to `form` (legacy full-profile default)
 *   - create accepts a declared mode (`voice`) and persists it
 *   - create rejects an undeclared mode with 400 INVALID_REGISTRATION_MODE
 *   - create rejects a non-snake_case mode value with 400 SCHEMA_VALIDATION
 *   - PATCH rejects any `registration_mode` in the body (UpdateLinkBodySchema
 *     is .strict(); this pins that as a regression)
 *   - create honours the `AGGREGATOR_ONBOARDING_ENABLED` allow-list (#637):
 *     a withheld mode is rejected even when called directly, and an omitted
 *     mode never falls back to one
 *
 * The blue_dot test fixture declares two modes: `voice` (account_only) and
 * `form` (account_and_profile). Uses a tracking stub for the registration-links
 * store + the in-memory aggregator fake. Auth is stubbed via
 * `_setAccessTokenVerifier`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';
import { UserStoreFake, _setUserStore, buildCoordinator } from '../services/user-store/index.js';
import { _setNetworkConfig } from '../services/network-config.js';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import {
  _setRegistrationLinksStore,
  RegistrationLinksStoreBase,
  type RegistrationLink,
  type CreateRegistrationLinkInput,
  type ListRegistrationLinksOptions,
  type RegistrationLinkStatus,
  type StoreError,
  type StoreResult,
} from '../services/registration-links-store/index.js';
import type { UpdateDraftInput } from '../services/registration-links-store/interface.js';
import type * as ObjectStorageModule from '../services/object-storage/index.js';
import { _setDbClients } from '../db/client.js';

// #650 regression guard: the QR is no longer persisted — create/activate must
// never touch object storage. Force the QR write primitives to REJECT (while
// keeping the real bulk-upload helpers via importActual, so buildApp's other
// routes still boot). If a putObject/signQrDownloadUrl call is ever
// reintroduced into the link routes, the "S3 independence" tests below fail.
vi.mock('../services/object-storage/index.js', async (importActual) => {
  const actual = await importActual<typeof ObjectStorageModule>();
  const rejectS3 = () =>
    Promise.reject(new Error('S3 must not be on the link create/activate path'));
  return {
    ...actual,
    putObject: vi.fn(rejectS3),
    // Removed in #650; re-declared as a rejecting stub in case it's re-added.
    signQrDownloadUrl: vi.fn(rejectS3),
  };
});

const AGG_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID = 'org-signalstack-1';
const ORG_SLUG = 'acme';
const USER_ID = 'kc-user-1';

/**
 * Tracking stub: records every create input and returns a synthetic row.
 * Status forced to 'draft' to keep the route off the QR/S3 path.
 */
class TrackingRegistrationLinksStore extends RegistrationLinksStoreBase {
  readonly creates: CreateRegistrationLinkInput[] = [];
  private idCounter = 0;

  async create(input: CreateRegistrationLinkInput): Promise<StoreResult<RegistrationLink>> {
    this.creates.push(input);
    this.idCounter++;
    const now = new Date();
    const row: RegistrationLink = {
      id: `link-${this.idCounter}`,
      aggregatorId: input.aggregatorId,
      slug: input.slug,
      domain: input.domain,
      context: input.context,
      registrationMode: input.registrationMode ?? 'form',
      qrObjectKey: null,
      status: input.status ?? 'draft',
      expiresAt: input.expiresAt ?? null,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    return { ok: true, value: row };
  }

  async findById(): Promise<StoreResult<RegistrationLink | null>> {
    return { ok: true, value: null };
  }
  async findBySlug(): Promise<StoreResult<RegistrationLink | null>> {
    return { ok: true, value: null };
  }
  async findByOrgAndSlug(): Promise<StoreResult<RegistrationLink | null>> {
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

const AUTH_TOKEN = 'agg-a-token';

/**
 * Minimal db stub that satisfies fetchLinkMetrics' query chain by resolving
 * to an empty rowset. The route then falls back to ZERO_METRICS — exactly
 * what we want since this test file does not exercise the metrics path.
 */
function buildMetricsStubDb(): unknown {
  const emptyChain = {
    select: () => emptyChain,
    from: () => emptyChain,
    where: () => emptyChain,
    groupBy: () => Promise.resolve([] as unknown[]),
  };
  return emptyChain;
}

async function bootApp(): Promise<{ app: FastifyInstance; store: TrackingRegistrationLinksStore }> {
  _resetJwks();
  process.env.KEYCLOAK_URL = 'http://kc.local';
  process.env.KEYCLOAK_REALM = 'bluedots';
  _setNetworkConfig(buildBlueDotConfig());
  _setAccessTokenVerifier(async (token) => {
    if (token !== AUTH_TOKEN) throw new Error('invalid');
    return {
      sub: USER_ID,
      email: 'a@x.com',
      aggregator_id: AGG_ID,
      aggregator_type: 'seeker',
      decision_made: 'approved',
    };
  });
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
  const store = new TrackingRegistrationLinksStore();
  _setRegistrationLinksStore(store);
  _setDbClients(null, buildMetricsStubDb() as never);
  const app = await buildApp();
  return { app, store };
}

describe('POST /v1/links/create — registration_mode', () => {
  let app: FastifyInstance;
  let store: TrackingRegistrationLinksStore;

  beforeEach(async () => {
    ({ app, store } = await bootApp());
  });
  afterEach(async () => {
    await app?.close();
    _setAccessTokenVerifier(null);
    _setUserStore(null);
    _setRegistrationLinksStore(null);
    _setNetworkConfig(null);
    _setDbClients(null, null);
  });

  it('defaults registration_mode to "form" when omitted', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/links/create',
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
      payload: { domain: 'seeker' },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().registration_mode).toBe('form');
    expect(store.creates).toHaveLength(1);
    expect(store.creates[0]!.registrationMode).toBe('form');
  });

  it('accepts registration_mode=voice and persists it', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/links/create',
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
      payload: { domain: 'seeker', registration_mode: 'voice' },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().registration_mode).toBe('voice');
    expect(store.creates[0]!.registrationMode).toBe('voice');
  });

  it('rejects an undeclared mode with 400 INVALID_REGISTRATION_MODE', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/links/create',
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
      payload: { domain: 'seeker', registration_mode: 'kiosk' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('INVALID_REGISTRATION_MODE');
    expect(store.creates).toHaveLength(0);
  });

  it('rejects a non-snake_case mode value with 400 SCHEMA_VALIDATION', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/links/create',
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
      payload: { domain: 'seeker', registration_mode: 'Bad-Key' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('SCHEMA_VALIDATION');
  });
});

describe('POST /v1/links/create — AGGREGATOR_ONBOARDING_ENABLED gate (#637)', () => {
  let app: FastifyInstance;
  let store: TrackingRegistrationLinksStore;
  const original = process.env.AGGREGATOR_ONBOARDING_ENABLED;

  beforeEach(async () => {
    ({ app, store } = await bootApp());
  });
  afterEach(async () => {
    await app?.close();
    _setAccessTokenVerifier(null);
    _setUserStore(null);
    _setRegistrationLinksStore(null);
    _setNetworkConfig(null);
    _setDbClients(null, null);
    if (original === undefined) delete process.env.AGGREGATOR_ONBOARDING_ENABLED;
    else process.env.AGGREGATOR_ONBOARDING_ENABLED = original;
  });

  const create = (payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/v1/links/create',
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
      payload,
    });

  it('rejects a withheld mode with 400 INVALID_REGISTRATION_MODE', async () => {
    // The config endpoint already hides `voice` from the dropdown, but the
    // gate has to hold for a caller hitting the API directly.
    process.env.AGGREGATOR_ONBOARDING_ENABLED = 'form';
    const r = await create({ domain: 'seeker', registration_mode: 'voice' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('INVALID_REGISTRATION_MODE');
    expect(store.creates).toHaveLength(0);
  });

  it('still creates an enabled mode with the var set', async () => {
    process.env.AGGREGATOR_ONBOARDING_ENABLED = 'form';
    const r = await create({ domain: 'seeker', registration_mode: 'form' });
    expect(r.statusCode).toBe(201);
    expect(r.json().registration_mode).toBe('form');
    expect(store.creates[0]!.registrationMode).toBe('form');
  });

  it('keeps both modes creatable when the var lists them all', async () => {
    process.env.AGGREGATOR_ONBOARDING_ENABLED = 'form,voice';
    const r = await create({ domain: 'seeker', registration_mode: 'voice' });
    expect(r.statusCode).toBe(201);
    expect(r.json().registration_mode).toBe('voice');
  });

  it('never falls back to a withheld mode when the mode is omitted', async () => {
    // `form` is withheld here, so the omitted-mode fallback must not land on
    // it; it picks the first *enabled* mode instead.
    process.env.AGGREGATOR_ONBOARDING_ENABLED = 'voice';
    const r = await create({ domain: 'seeker' });
    expect(r.statusCode).toBe(201);
    expect(r.json().registration_mode).toBe('voice');
    expect(store.creates[0]!.registrationMode).toBe('voice');
  });

  it('still prefers form for an omitted mode when form is enabled', async () => {
    process.env.AGGREGATOR_ONBOARDING_ENABLED = 'form';
    const r = await create({ domain: 'seeker' });
    expect(r.statusCode).toBe(201);
    expect(r.json().registration_mode).toBe('form');
  });

  it('rejects every mode — including an omitted one — when nothing is enabled', async () => {
    // An all-typo allow-list. Loud 400s, not a silent fall-open to all modes.
    process.env.AGGREGATOR_ONBOARDING_ENABLED = 'frm';
    const omitted = await create({ domain: 'seeker' });
    expect(omitted.statusCode).toBe(400);
    expect(omitted.json().error.code).toBe('INVALID_REGISTRATION_MODE');
    const explicit = await create({ domain: 'seeker', registration_mode: 'form' });
    expect(explicit.statusCode).toBe(400);
    expect(store.creates).toHaveLength(0);
  });

  it('surfaces the declared and the enabled mode lists on the error', async () => {
    process.env.AGGREGATOR_ONBOARDING_ENABLED = 'form';
    const r = await create({ domain: 'seeker', registration_mode: 'voice' });
    const err = r.json().error as { detail: string; fields: Record<string, unknown> };
    // "not enabled" rather than "not declared" — the operator needs to know
    // this is a deployment setting, not a missing YAML entry.
    expect(err.detail).toContain('not enabled');
    expect(err.fields.declared).toEqual(['voice', 'form']);
    expect(err.fields.enabled).toEqual(['form']);
  });

  it('leaves an undeclared mode reported as undeclared, not as withheld', async () => {
    process.env.AGGREGATOR_ONBOARDING_ENABLED = 'form';
    const r = await create({ domain: 'seeker', registration_mode: 'kiosk' });
    expect(r.statusCode).toBe(400);
    expect((r.json().error as { detail: string }).detail).toContain('not declared');
  });

  it('behaves exactly as before when the var is unset', async () => {
    delete process.env.AGGREGATOR_ONBOARDING_ENABLED;
    const voice = await create({ domain: 'seeker', registration_mode: 'voice' });
    expect(voice.statusCode).toBe(201);
    const omitted = await create({ domain: 'seeker' });
    expect(omitted.json().registration_mode).toBe('form');
  });
});

describe('PATCH /v1/links/:id — registration_mode immutability', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    ({ app } = await bootApp());
  });
  afterEach(async () => {
    await app?.close();
    _setAccessTokenVerifier(null);
    _setUserStore(null);
    _setRegistrationLinksStore(null);
    _setNetworkConfig(null);
    _setDbClients(null, null);
  });

  it('rejects body containing registration_mode with 400', async () => {
    const r = await app.inject({
      method: 'PATCH',
      url: '/v1/links/00000000-0000-4000-8000-000000000001',
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
      payload: { registration_mode: 'voice' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('SCHEMA_VALIDATION');
  });
});

// ---------------------------------------------------------------------------
// Full CRUD lifecycle — create/list/read/patch/activate/deactivate against a
// stateful in-memory fake, covering the auth wrapper, aggregator-type
// enforcement, slug-collision retries, QR/S3 side effects, and every
// upstream-failure branch. `TrackingRegistrationLinksStore` above stays
// scoped to the registration_mode-specific tests; this fake models the full
// abstract contract so the rest of the route file's branches are exercised.
// ---------------------------------------------------------------------------

function buildLink(overrides: Partial<RegistrationLink> = {}): RegistrationLink {
  const now = new Date('2026-08-01T00:00:00.000Z');
  return {
    id: 'link-fixed',
    aggregatorId: AGG_ID,
    slug: 'my-slug',
    domain: 'seeker',
    context: {},
    registrationMode: 'form',
    qrObjectKey: null,
    status: 'draft',
    expiresAt: null,
    createdBy: USER_ID,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Stateful in-memory fake covering the full `RegistrationLinksStoreBase` contract. */
class FullRegistrationLinksStore extends RegistrationLinksStoreBase {
  private rows = new Map<string, RegistrationLink>();
  private seq = 0;
  private failNext = new Map<string, StoreError>();

  seed(rows: RegistrationLink[]): void {
    for (const r of rows) this.rows.set(r.id, r);
  }

  /** Force the next call to `method` to resolve with `error` instead. */
  failOnce(method: string, error: StoreError): void {
    this.failNext.set(method, error);
  }

  private take(method: string): StoreError | undefined {
    const e = this.failNext.get(method);
    if (e) this.failNext.delete(method);
    return e;
  }

  private slugTaken(aggregatorId: string, slug: string, excludeId?: string): boolean {
    for (const r of this.rows.values()) {
      if (r.aggregatorId === aggregatorId && r.slug === slug && r.id !== excludeId) return true;
    }
    return false;
  }

  async create(input: CreateRegistrationLinkInput): Promise<StoreResult<RegistrationLink>> {
    const fail = this.take('create');
    if (fail) return { ok: false, error: fail };
    if (this.slugTaken(input.aggregatorId, input.slug)) {
      return { ok: false, error: { code: 'SLUG_COLLISION', message: 'slug taken' } };
    }
    this.seq += 1;
    const now = new Date('2026-08-01T00:00:00.000Z');
    const row: RegistrationLink = {
      id: `link-${this.seq}`,
      aggregatorId: input.aggregatorId,
      slug: input.slug,
      domain: input.domain,
      context: input.context,
      registrationMode: input.registrationMode ?? 'form',
      qrObjectKey: null,
      status: input.status ?? 'draft',
      expiresAt: input.expiresAt ?? null,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.id, row);
    return { ok: true, value: row };
  }

  async findById(id: string, aggregatorId: string): Promise<StoreResult<RegistrationLink | null>> {
    const fail = this.take('findById');
    if (fail) return { ok: false, error: fail };
    const row = this.rows.get(id);
    if (!row || row.aggregatorId !== aggregatorId) return { ok: true, value: null };
    return { ok: true, value: row };
  }

  async findBySlug(): Promise<StoreResult<RegistrationLink | null>> {
    return { ok: true, value: null };
  }

  async findByOrgAndSlug(): Promise<StoreResult<RegistrationLink | null>> {
    return { ok: true, value: null };
  }

  async updateDraft(
    id: string,
    aggregatorId: string,
    patch: UpdateDraftInput,
  ): Promise<StoreResult<RegistrationLink>> {
    const fail = this.take('updateDraft');
    if (fail) return { ok: false, error: fail };
    const row = this.rows.get(id);
    if (!row || row.aggregatorId !== aggregatorId || row.status !== 'draft') {
      return { ok: false, error: { code: 'NOT_FOUND', message: 'not a draft' } };
    }
    if (patch.slug !== undefined && this.slugTaken(aggregatorId, patch.slug, id)) {
      return { ok: false, error: { code: 'SLUG_COLLISION', message: 'slug taken' } };
    }
    const updated: RegistrationLink = {
      ...row,
      ...(patch.slug !== undefined ? { slug: patch.slug } : {}),
      ...(patch.context !== undefined ? { context: patch.context } : {}),
      ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt } : {}),
      updatedAt: new Date(),
    };
    this.rows.set(id, updated);
    return { ok: true, value: updated };
  }

  async list(
    aggregatorId: string,
    options: ListRegistrationLinksOptions,
  ): Promise<StoreResult<{ rows: RegistrationLink[]; total: number }>> {
    const fail = this.take('list');
    if (fail) return { ok: false, error: fail };
    let rows = [...this.rows.values()].filter((r) => r.aggregatorId === aggregatorId);
    if (options.status) rows = rows.filter((r) => r.status === options.status);
    rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return {
      ok: true,
      value: {
        rows: rows.slice(options.offset, options.offset + options.limit),
        total: rows.length,
      },
    };
  }

  async updateStatus(
    id: string,
    aggregatorId: string,
    nextStatus: RegistrationLinkStatus,
  ): Promise<StoreResult<RegistrationLink>> {
    const fail = this.take('updateStatus');
    if (fail) return { ok: false, error: fail };
    const row = this.rows.get(id);
    if (!row || row.aggregatorId !== aggregatorId) {
      return { ok: false, error: { code: 'NOT_FOUND', message: 'not found' } };
    }
    const updated = { ...row, status: nextStatus, updatedAt: new Date() };
    this.rows.set(id, updated);
    return { ok: true, value: updated };
  }

  get(id: string): RegistrationLink | undefined {
    return this.rows.get(id);
  }
}

interface MetricsRow {
  linkId: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

function buildMetricsDb(rows: MetricsRow[] = []): unknown {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    groupBy: () => Promise.resolve(rows),
  };
  return chain;
}

const TOKEN_SEEKER_APPROVED = 'full-seeker-approved';
const TOKEN_PROVIDER_APPROVED = 'full-provider-approved';
const TOKEN_PENDING = 'full-pending';
const TOKEN_NO_AGG_TYPE = 'full-no-agg-type';

async function bootFullApp(opts: {
  store: FullRegistrationLinksStore;
  userStore?: UserStoreFake;
  metricsRows?: MetricsRow[];
}): Promise<FastifyInstance> {
  _resetJwks();
  process.env.KEYCLOAK_URL = 'http://kc.local';
  process.env.KEYCLOAK_REALM = 'aggregator';
  _setNetworkConfig(buildBlueDotConfig());
  _setAccessTokenVerifier(async (token) => {
    if (token === TOKEN_SEEKER_APPROVED) {
      return {
        sub: USER_ID,
        aggregator_id: AGG_ID,
        aggregator_type: 'seeker',
        decision_made: 'approved',
      };
    }
    if (token === TOKEN_PROVIDER_APPROVED) {
      return {
        sub: USER_ID,
        aggregator_id: AGG_ID,
        aggregator_type: 'provider',
        decision_made: 'approved',
      };
    }
    if (token === TOKEN_PENDING) {
      return {
        sub: USER_ID,
        aggregator_id: AGG_ID,
        aggregator_type: 'seeker',
        decision_made: 'pending',
      };
    }
    if (token === TOKEN_NO_AGG_TYPE) {
      return { sub: USER_ID, aggregator_id: AGG_ID, decision_made: 'approved' };
    }
    throw new Error('invalid token');
  });

  const userStore =
    opts.userStore ??
    (() => {
      const s = new UserStoreFake();
      s.seed([
        buildCoordinator({
          id: AGG_ID,
          orgSlug: ORG_SLUG,
          name: 'Acme',
          status: 'active',
          signalstackOrgId: ORG_ID,
        }),
      ]);
      return s;
    })();
  _setUserStore(userStore);
  _setRegistrationLinksStore(opts.store);
  _setDbClients(null, buildMetricsDb(opts.metricsRows ?? []) as never);

  return buildApp();
}

async function teardownFullApp(app: FastifyInstance | undefined): Promise<void> {
  await app?.close();
  _setAccessTokenVerifier(null);
  _setUserStore(null);
  _setRegistrationLinksStore(null);
  _setNetworkConfig(null);
  _setDbClients(null, null);
}

describe('registration-links auth wrapper (requireAuth)', () => {
  let app: FastifyInstance;
  let store: FullRegistrationLinksStore;

  beforeEach(async () => {
    store = new FullRegistrationLinksStore();
    app = await bootFullApp({ store });
  });
  afterEach(async () => teardownFullApp(app));

  it('401s without a Bearer token', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/links' });
    expect(r.statusCode).toBe(401);
  });

  it('403 NOT_APPROVED when decision_made is pending', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/v1/links',
      headers: { authorization: `Bearer ${TOKEN_PENDING}` },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('NOT_APPROVED');
  });
});

describe('POST /v1/links/create — full lifecycle', () => {
  let app: FastifyInstance;
  let store: FullRegistrationLinksStore;

  beforeEach(async () => {
    store = new FullRegistrationLinksStore();
    app = await bootFullApp({ store });
  });
  afterEach(async () => teardownFullApp(app));

  it('rejects an unknown domain with 400 SCHEMA_VALIDATION', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/links/create',
      headers: { authorization: `Bearer ${TOKEN_SEEKER_APPROVED}` },
      payload: { domain: 'bogus' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('SCHEMA_VALIDATION');
  });

  it('403 AGGREGATOR_TYPE_MISSING when the token has no aggregator_type claim', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/links/create',
      headers: { authorization: `Bearer ${TOKEN_NO_AGG_TYPE}` },
      payload: { domain: 'seeker' },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('AGGREGATOR_TYPE_MISSING');
  });

  it('403 AGGREGATOR_TYPE_MISMATCH when creating a link for a different domain', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/links/create',
      headers: { authorization: `Bearer ${TOKEN_SEEKER_APPROVED}` },
      payload: { domain: 'provider' },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('AGGREGATOR_TYPE_MISMATCH');
  });

  it('retries once on a slug collision and succeeds with a suffixed slug', async () => {
    store.seed([buildLink({ id: 'existing', slug: 'taken-slug', aggregatorId: AGG_ID })]);
    const r = await app.inject({
      method: 'POST',
      url: '/v1/links/create',
      headers: { authorization: `Bearer ${TOKEN_SEEKER_APPROVED}` },
      payload: { domain: 'seeker', slug: 'taken-slug' },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json() as { slug: string };
    expect(body.slug).toMatch(/^taken-slug-[0-9a-f]{4}$/);
  });

  it('503 DB_UNAVAILABLE when store.create fails for a non-collision reason', async () => {
    store.failOnce('create', { code: 'DB_UNAVAILABLE', message: 'db down' });
    const r = await app.inject({
      method: 'POST',
      url: '/v1/links/create',
      headers: { authorization: `Bearer ${TOKEN_SEEKER_APPROVED}` },
      payload: { domain: 'seeker' },
    });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('DB_UNAVAILABLE');
  });

  it('503 DUPLICATE_SLUG when every slug retry collides', async () => {
    // Seed a row occupying every suffix the route could generate is
    // impractical (random suffixes) — instead, force create() to always
    // report a collision so the retry loop exhausts.
    const alwaysCollide = new (class extends FullRegistrationLinksStore {
      override async create(): Promise<StoreResult<RegistrationLink>> {
        return { ok: false, error: { code: 'SLUG_COLLISION', message: 'always taken' } };
      }
    })();
    await app.close();
    app = await bootFullApp({ store: alwaysCollide });
    const r = await app.inject({
      method: 'POST',
      url: '/v1/links/create',
      headers: { authorization: `Bearer ${TOKEN_SEEKER_APPROVED}` },
      payload: { domain: 'seeker' },
    });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('DUPLICATE_SLUG');
  });

  it('503 DB_UNAVAILABLE when the caller aggregator row cannot be loaded', async () => {
    const emptyAggStore = new UserStoreFake();
    await app.close();
    app = await bootFullApp({ store, userStore: emptyAggStore });
    const r = await app.inject({
      method: 'POST',
      url: '/v1/links/create',
      headers: { authorization: `Bearer ${TOKEN_SEEKER_APPROVED}` },
      payload: { domain: 'seeker' },
    });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('DB_UNAVAILABLE');
  });

  it('201s a draft with no QR/public URL (drafts are metadata-only)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/links/create',
      headers: { authorization: `Bearer ${TOKEN_SEEKER_APPROVED}` },
      payload: { domain: 'seeker', status: 'draft' },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json() as { status: string; qr_url: string | null; public_url: string | null };
    expect(body.status).toBe('draft');
    expect(body.qr_url).toBeNull();
    expect(body.public_url).toBeNull();
  });

  it('201s a live link with a public URL and no server-side QR (#650)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/links/create',
      headers: { authorization: `Bearer ${TOKEN_SEEKER_APPROVED}` },
      payload: { domain: 'seeker', slug: 'live-one', status: 'live' },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json() as { status: string; qr_url: string | null; public_url: string | null };
    expect(body.status).toBe('live');
    expect(body.public_url).toBe('http://localhost:3000/acme/live-one');
    // QR is derived client-side from public_url — never returned by the API.
    expect(body.qr_url).toBeNull();
  });
});

describe('GET /v1/links — list', () => {
  let app: FastifyInstance;
  let store: FullRegistrationLinksStore;

  beforeEach(async () => {
    store = new FullRegistrationLinksStore();
  });
  afterEach(async () => teardownFullApp(app));

  it('503 DB_UNAVAILABLE when the store list fails', async () => {
    store.failOnce('list', { code: 'DB_UNAVAILABLE', message: 'db down' });
    app = await bootFullApp({ store });
    const r = await app.inject({
      method: 'GET',
      url: '/v1/links',
      headers: { authorization: `Bearer ${TOKEN_SEEKER_APPROVED}` },
    });
    expect(r.statusCode).toBe(503);
  });

  it('200s with metrics attached from the grouped rollup query', async () => {
    store.seed([
      buildLink({ id: 'link-a', slug: 'a', status: 'live', qrObjectKey: 'qr/a.png' }),
      buildLink({ id: 'link-b', slug: 'b', status: 'draft' }),
    ]);
    app = await bootFullApp({
      store,
      metricsRows: [{ linkId: 'link-a', total: 10, passed: 8, failed: 2, skipped: 0 }],
    });
    const r = await app.inject({
      method: 'GET',
      url: '/v1/links',
      headers: { authorization: `Bearer ${TOKEN_SEEKER_APPROVED}` },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as {
      items: Array<{ link_id: string; metrics: { total: number }; qr_url: string | null }>;
      total: number;
    };
    expect(body.total).toBe(2);
    const a = body.items.find((i) => i.link_id === 'link-a');
    expect(a?.metrics.total).toBe(10);
    // #650: a legacy row with a stored qr_object_key still returns qr_url null.
    expect(a?.qr_url).toBeNull();
    const b = body.items.find((i) => i.link_id === 'link-b');
    expect(b?.metrics.total).toBe(0);
  });

  it('filters by status query param', async () => {
    store.seed([
      buildLink({ id: 'link-live', slug: 'live-x', status: 'live' }),
      buildLink({ id: 'link-draft', slug: 'draft-x', status: 'draft' }),
    ]);
    app = await bootFullApp({ store });
    const r = await app.inject({
      method: 'GET',
      url: '/v1/links?status=draft',
      headers: { authorization: `Bearer ${TOKEN_SEEKER_APPROVED}` },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { items: Array<{ link_id: string }> };
    expect(body.items.map((i) => i.link_id)).toEqual(['link-draft']);
  });
});

describe('GET /v1/links/:id — read', () => {
  let app: FastifyInstance;
  let store: FullRegistrationLinksStore;

  beforeEach(async () => {
    store = new FullRegistrationLinksStore();
    app = await bootFullApp({ store });
  });
  afterEach(async () => teardownFullApp(app));

  it('503 DB_UNAVAILABLE when findById fails', async () => {
    store.failOnce('findById', { code: 'DB_UNAVAILABLE', message: 'db down' });
    const r = await app.inject({
      method: 'GET',
      url: '/v1/links/link-1',
      headers: { authorization: `Bearer ${TOKEN_SEEKER_APPROVED}` },
    });
    expect(r.statusCode).toBe(503);
  });

  it('403 FORBIDDEN for a cross-aggregator / unknown id (no enumeration leak)', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/v1/links/does-not-exist',
      headers: { authorization: `Bearer ${TOKEN_SEEKER_APPROVED}` },
    });
    expect(r.statusCode).toBe(403);
  });

  it('200s a live link with the public URL and no server-side QR (#650)', async () => {
    store.seed([
      buildLink({
        id: 'link-live',
        slug: 'live-read',
        status: 'live',
        // Legacy row: a key may still be stored, but the read never signs it.
        qrObjectKey: 'qr/live-read.png',
      }),
    ]);
    const r = await app.inject({
      method: 'GET',
      url: '/v1/links/link-live',
      headers: { authorization: `Bearer ${TOKEN_SEEKER_APPROVED}` },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as {
      qr_url: string | null;
      qr_expires_at: string | null;
      public_url: string | null;
    };
    expect(body.qr_url).toBeNull();
    // The legacy sibling field is hard-null too (no presigned URL to expire).
    expect(body.qr_expires_at).toBeNull();
    expect(body.public_url).toBe('http://localhost:3000/acme/live-read');
  });
});

describe('PATCH /v1/links/:id — full lifecycle', () => {
  let app: FastifyInstance;
  let store: FullRegistrationLinksStore;

  beforeEach(async () => {
    store = new FullRegistrationLinksStore();
    app = await bootFullApp({ store });
  });
  afterEach(async () => teardownFullApp(app));

  it('503 DB_UNAVAILABLE when findById fails', async () => {
    store.failOnce('findById', { code: 'DB_UNAVAILABLE', message: 'db down' });
    const r = await app.inject({
      method: 'PATCH',
      url: '/v1/links/link-1',
      headers: { authorization: `Bearer ${TOKEN_SEEKER_APPROVED}` },
      payload: {},
    });
    expect(r.statusCode).toBe(503);
  });

  it('403 FORBIDDEN when the link is not accessible', async () => {
    const r = await app.inject({
      method: 'PATCH',
      url: '/v1/links/does-not-exist',
      headers: { authorization: `Bearer ${TOKEN_SEEKER_APPROVED}` },
      payload: {},
    });
    expect(r.statusCode).toBe(403);
  });

  it('409 CONFLICT when the link is no longer a draft', async () => {
    store.seed([buildLink({ id: 'link-live', status: 'live' })]);
    const r = await app.inject({
      method: 'PATCH',
      url: '/v1/links/link-live',
      headers: { authorization: `Bearer ${TOKEN_SEEKER_APPROVED}` },
      payload: { context: { a: 1 } },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('CONFLICT');
  });

  it('200s updating context/expiry without touching the slug', async () => {
    store.seed([buildLink({ id: 'link-draft', slug: 'stays-same' })]);
    const r = await app.inject({
      method: 'PATCH',
      url: '/v1/links/link-draft',
      headers: { authorization: `Bearer ${TOKEN_SEEKER_APPROVED}` },
      payload: { context: { note: 'updated' }, expires_at: '2027-01-01T00:00:00Z' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { slug: string; context: Record<string, unknown>; expires_at: string };
    expect(body.slug).toBe('stays-same');
    expect(body.context).toEqual({ note: 'updated' });
    expect(body.expires_at).toBe('2027-01-01T00:00:00.000Z');
  });

  it('200s and retries once when the requested slug collides with a sibling link', async () => {
    store.seed([
      buildLink({ id: 'link-a', slug: 'wanted' }),
      buildLink({ id: 'link-b', slug: 'original-b' }),
    ]);
    const r = await app.inject({
      method: 'PATCH',
      url: '/v1/links/link-b',
      headers: { authorization: `Bearer ${TOKEN_SEEKER_APPROVED}` },
      payload: { slug: 'wanted' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { slug: string };
    expect(body.slug).toMatch(/^wanted-[0-9a-f]{4}$/);
  });

  it('503 DB_UNAVAILABLE when updateDraft fails for a non-collision, non-not-found reason', async () => {
    store.seed([buildLink({ id: 'link-draft' })]);
    store.failOnce('updateDraft', { code: 'DB_UNAVAILABLE', message: 'db down' });
    const r = await app.inject({
      method: 'PATCH',
      url: '/v1/links/link-draft',
      headers: { authorization: `Bearer ${TOKEN_SEEKER_APPROVED}` },
      payload: { slug: 'new-slug' },
    });
    expect(r.statusCode).toBe(503);
  });

  it('409 CONFLICT when updateDraft (slug path) reports the link raced out of draft', async () => {
    store.seed([buildLink({ id: 'link-draft' })]);
    const racing = new (class extends FullRegistrationLinksStore {
      override async updateDraft(): Promise<StoreResult<RegistrationLink>> {
        return { ok: false, error: { code: 'NOT_FOUND', message: 'raced' } };
      }
    })();
    racing.seed([buildLink({ id: 'link-draft' })]);
    await app.close();
    app = await bootFullApp({ store: racing });
    const r = await app.inject({
      method: 'PATCH',
      url: '/v1/links/link-draft',
      headers: { authorization: `Bearer ${TOKEN_SEEKER_APPROVED}` },
      payload: { slug: 'new-slug' },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('CONFLICT');
  });

  it('409 CONFLICT when updateDraft (no-slug path) reports the link raced out of draft', async () => {
    const racing = new (class extends FullRegistrationLinksStore {
      override async updateDraft(): Promise<StoreResult<RegistrationLink>> {
        return { ok: false, error: { code: 'NOT_FOUND', message: 'raced' } };
      }
    })();
    racing.seed([buildLink({ id: 'link-draft' })]);
    await app.close();
    app = await bootFullApp({ store: racing });
    const r = await app.inject({
      method: 'PATCH',
      url: '/v1/links/link-draft',
      headers: { authorization: `Bearer ${TOKEN_SEEKER_APPROVED}` },
      payload: { context: { a: 1 } },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('CONFLICT');
  });

  it('503 DB_UNAVAILABLE when updateDraft (no-slug path) fails for a DB reason', async () => {
    store.seed([buildLink({ id: 'link-draft' })]);
    store.failOnce('updateDraft', { code: 'DB_UNAVAILABLE', message: 'db down' });
    const r = await app.inject({
      method: 'PATCH',
      url: '/v1/links/link-draft',
      headers: { authorization: `Bearer ${TOKEN_SEEKER_APPROVED}` },
      payload: { context: { a: 1 } },
    });
    expect(r.statusCode).toBe(503);
  });

  it('503 DUPLICATE_SLUG when every slug retry collides', async () => {
    store.seed([buildLink({ id: 'link-draft' })]);
    const alwaysCollide = new (class extends FullRegistrationLinksStore {
      override async updateDraft(): Promise<StoreResult<RegistrationLink>> {
        return { ok: false, error: { code: 'SLUG_COLLISION', message: 'always taken' } };
      }
    })();
    alwaysCollide.seed([buildLink({ id: 'link-draft' })]);
    await app.close();
    app = await bootFullApp({ store: alwaysCollide });
    const r = await app.inject({
      method: 'PATCH',
      url: '/v1/links/link-draft',
      headers: { authorization: `Bearer ${TOKEN_SEEKER_APPROVED}` },
      payload: { slug: 'wanted' },
    });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('DUPLICATE_SLUG');
  });
});

describe('POST /v1/links/:id/activate', () => {
  let app: FastifyInstance;
  let store: FullRegistrationLinksStore;

  beforeEach(async () => {
    store = new FullRegistrationLinksStore();
    app = await bootFullApp({ store });
  });
  afterEach(async () => teardownFullApp(app));

  it('503 DB_UNAVAILABLE when findById fails', async () => {
    store.failOnce('findById', { code: 'DB_UNAVAILABLE', message: 'db down' });
    const r = await app.inject({
      method: 'POST',
      url: '/v1/links/link-1/activate',
      headers: { authorization: `Bearer ${TOKEN_SEEKER_APPROVED}` },
    });
    expect(r.statusCode).toBe(503);
  });

  it('403 FORBIDDEN when the link is not accessible', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/links/does-not-exist/activate',
      headers: { authorization: `Bearer ${TOKEN_SEEKER_APPROVED}` },
    });
    expect(r.statusCode).toBe(403);
  });

  it('is idempotent (200) when already live', async () => {
    store.seed([buildLink({ id: 'link-live', status: 'live', qrObjectKey: 'qr/x.png' })]);
    const r = await app.inject({
      method: 'POST',
      url: '/v1/links/link-live/activate',
      headers: { authorization: `Bearer ${TOKEN_SEEKER_APPROVED}` },
    });
    expect(r.statusCode).toBe(200);
  });

  it('409 CONFLICT when the link is retired', async () => {
    store.seed([buildLink({ id: 'link-retired', status: 'retired' })]);
    const r = await app.inject({
      method: 'POST',
      url: '/v1/links/link-retired/activate',
      headers: { authorization: `Bearer ${TOKEN_SEEKER_APPROVED}` },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('CONFLICT');
  });

  it('200s activating a draft — live with public URL, no server-side QR (#650)', async () => {
    store.seed([buildLink({ id: 'link-draft', slug: 'to-activate', status: 'draft' })]);
    const r = await app.inject({
      method: 'POST',
      url: '/v1/links/link-draft/activate',
      headers: { authorization: `Bearer ${TOKEN_SEEKER_APPROVED}` },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { status: string; public_url: string | null; qr_url: string | null };
    expect(body.status).toBe('live');
    expect(body.public_url).toBe('http://localhost:3000/acme/to-activate');
    expect(body.qr_url).toBeNull();
  });

  it('503 DB_UNAVAILABLE when the status flip fails', async () => {
    store.seed([buildLink({ id: 'link-draft', status: 'draft' })]);
    store.failOnce('updateStatus', { code: 'DB_UNAVAILABLE', message: 'db down' });
    const r = await app.inject({
      method: 'POST',
      url: '/v1/links/link-draft/activate',
      headers: { authorization: `Bearer ${TOKEN_SEEKER_APPROVED}` },
    });
    expect(r.statusCode).toBe(503);
  });
});

// #650: object storage is mocked to REJECT for this whole file (see the
// vi.mock at the top). These assert the central promise deterministically:
// activation is independent of S3 — a create-live and a draft activation both
// succeed even though every object-storage write would throw. If a QR→S3 write
// is reintroduced into either path, these fail with 500 INTERNAL.
describe('S3 independence (#650)', () => {
  let app: FastifyInstance;
  let store: FullRegistrationLinksStore;

  beforeEach(async () => {
    store = new FullRegistrationLinksStore();
    app = await bootFullApp({ store });
  });
  afterEach(async () => teardownFullApp(app));

  it('creates a live link with S3 unreachable — 201, qr_url null', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/links/create',
      headers: { authorization: `Bearer ${TOKEN_SEEKER_APPROVED}` },
      payload: { domain: 'seeker', slug: 'live-nos3', status: 'live' },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json() as { status: string; qr_url: string | null; public_url: string | null };
    expect(body.status).toBe('live');
    expect(body.public_url).toBe('http://localhost:3000/acme/live-nos3');
    expect(body.qr_url).toBeNull();
  });

  it('activates a draft with S3 unreachable — 200, qr_url null', async () => {
    store.seed([buildLink({ id: 'link-draft', slug: 'act-nos3', status: 'draft' })]);
    const r = await app.inject({
      method: 'POST',
      url: '/v1/links/link-draft/activate',
      headers: { authorization: `Bearer ${TOKEN_SEEKER_APPROVED}` },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { status: string; qr_url: string | null };
    expect(body.status).toBe('live');
    expect(body.qr_url).toBeNull();
  });
});

describe('POST /v1/links/:id/deactivate', () => {
  let app: FastifyInstance;
  let store: FullRegistrationLinksStore;

  beforeEach(async () => {
    store = new FullRegistrationLinksStore();
    app = await bootFullApp({ store });
  });
  afterEach(async () => teardownFullApp(app));

  it('503 DB_UNAVAILABLE when findById fails', async () => {
    store.failOnce('findById', { code: 'DB_UNAVAILABLE', message: 'db down' });
    const r = await app.inject({
      method: 'POST',
      url: '/v1/links/link-1/deactivate',
      headers: { authorization: `Bearer ${TOKEN_SEEKER_APPROVED}` },
    });
    expect(r.statusCode).toBe(503);
  });

  it('403 FORBIDDEN when the link is not accessible', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/links/does-not-exist/deactivate',
      headers: { authorization: `Bearer ${TOKEN_SEEKER_APPROVED}` },
    });
    expect(r.statusCode).toBe(403);
  });

  it('is idempotent (200) when already retired', async () => {
    store.seed([buildLink({ id: 'link-retired', status: 'retired' })]);
    const r = await app.inject({
      method: 'POST',
      url: '/v1/links/link-retired/deactivate',
      headers: { authorization: `Bearer ${TOKEN_SEEKER_APPROVED}` },
    });
    expect(r.statusCode).toBe(200);
  });

  it('200s retiring a live link', async () => {
    store.seed([buildLink({ id: 'link-live', status: 'live' })]);
    const r = await app.inject({
      method: 'POST',
      url: '/v1/links/link-live/deactivate',
      headers: { authorization: `Bearer ${TOKEN_SEEKER_APPROVED}` },
    });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { status: string }).status).toBe('retired');
  });

  it('503 DB_UNAVAILABLE when the status flip fails', async () => {
    store.seed([buildLink({ id: 'link-live', status: 'live' })]);
    store.failOnce('updateStatus', { code: 'DB_UNAVAILABLE', message: 'db down' });
    const r = await app.inject({
      method: 'POST',
      url: '/v1/links/link-live/deactivate',
      headers: { authorization: `Bearer ${TOKEN_SEEKER_APPROVED}` },
    });
    expect(r.statusCode).toBe(503);
  });
});
