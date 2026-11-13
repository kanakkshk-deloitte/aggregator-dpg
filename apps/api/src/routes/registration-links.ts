/**
 * Registration links endpoints of the aggregator API (`@aggregator-dpg/api`).
 *
 *   POST /v1/links/create              create a link (QR is made client-side)
 *   GET  /v1/links                     list links scoped to aggregator
 *   GET  /v1/links/:id                 read a single link
 *   POST /v1/links/:id/activate        flip a draft link to live (idempotent)
 *   POST /v1/links/:id/deactivate      retire a link (idempotent)
 *
 * All endpoints need an authenticated aggregator JWT and are scoped by the
 * `aggregator_id` claim.
 */

import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { requireApproved, type AuthContext } from '../services/auth/access-token.js';
import { getUserStore } from '../services/user-store/index.js';
import { getRegistrationLinksStore } from '../services/registration-links-store/index.js';
import type { RegistrationLink } from '../services/registration-links-store/index.js';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';
import { config, enabledRegistrationModes } from '../config.js';
import { getDb } from '../db/client.js';
import { onboarding } from '../db/schema.js';
import { getNetworkConfig } from '../services/network-config.js';
import { stripTrailingSlashes } from '@aggregator-dpg/shared-primitives/url';
import { callerFromAuth, recordRouteCaller } from '../services/authz/index.js';

interface LinkMetrics {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

const ZERO_METRICS: LinkMetrics = { total: 0, passed: 0, failed: 0, skipped: 0 };

/**
 * Sums the `onboarding` rows (source='link') for the given link ids of one
 * aggregator. Returns a Map keyed by link_id; a missing key means no submissions yet.
 */
async function fetchLinkMetrics(
  aggregatorId: string,
  linkIds: string[],
): Promise<Map<string, LinkMetrics>> {
  const out = new Map<string, LinkMetrics>();
  if (linkIds.length === 0) return out;
  const rows = await getDb()
    .select({
      linkId: onboarding.linkId,
      total: sql<number>`coalesce(sum(${onboarding.total}), 0)::int`,
      passed: sql<number>`coalesce(sum(${onboarding.passed}), 0)::int`,
      failed: sql<number>`coalesce(sum(${onboarding.failed}), 0)::int`,
      skipped: sql<number>`coalesce(sum(${onboarding.skipped}), 0)::int`,
    })
    .from(onboarding)
    .where(
      and(
        eq(onboarding.userId, aggregatorId),
        eq(onboarding.source, 'link'),
        inArray(onboarding.linkId, linkIds),
      ),
    )
    .groupBy(onboarding.linkId);
  for (const r of rows) {
    if (!r.linkId) continue;
    out.set(r.linkId, {
      total: r.total ?? 0,
      passed: r.passed ?? 0,
      failed: r.failed ?? 0,
      skipped: r.skipped ?? 0,
    });
  }
  return out;
}

const CreateLinkBodySchema = z.object({
  domain: z.string().min(1),
  /**
   * Optional slug: lowercase, hyphen-separated, 3-60 chars. On collision a short
   * random suffix is added; `public_url` carries the final slug.
   */
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase + hyphens (a-z, 0-9)')
    .min(3)
    .max(60)
    .optional(),
  context: z.record(z.unknown()).default({}),
  status: z.enum(['draft', 'live']).default('draft'),
  /**
   * Registration mode key (e.g. `voice`, `form`), checked against the network
   * config's `registration_modes`. Defaults to `form`. Cannot be changed after creation.
   */
  registration_mode: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .optional(),
  expires_at: z
    .string()
    .datetime({ offset: true })
    .nullish()
    .transform((v) => (v ? new Date(v) : null)),
});

/**
 * Patch shape for `PATCH /v1/links/:id`. Only draft-editable fields; `domain`
 * and `status` are not editable here.
 */
const UpdateLinkBodySchema = z
  .object({
    slug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase + hyphens (a-z, 0-9)')
      .min(3)
      .max(60)
      .optional(),
    context: z.record(z.unknown()).optional(),
    expires_at: z
      .string()
      .datetime({ offset: true })
      .nullish()
      .transform((v) => (v === undefined ? undefined : v === null ? null : new Date(v))),
  })
  .strict();

const SLUG_RETRIES = 5;

const ListQuerySchema = z.object({
  status: z.enum(['draft', 'live', 'retired']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Path params for routes addressing a single registration link. */
const LinkParamsSchema = z.object({
  id: z.string().min(1).describe('Registration link id (UUID).'),
});

/** Canonical wire shape of a registration link (see {@link buildResponse}). */
const LinkResponseSchema = z
  .object({
    link_id: z.string(),
    slug: z.string(),
    domain: z.string(),
    status: z.string(),
    registration_mode: z.string(),
    context: z.record(z.unknown()),
    expires_at: z.string().nullable(),
    public_url: z.string().nullable(),
    qr_url: z.string().nullable(),
    qr_expires_at: z.string().nullable(),
    metrics: z
      .object({
        total: z.number(),
        passed: z.number(),
        failed: z.number(),
        skipped: z.number(),
      })
      .passthrough(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .passthrough();

/** 200 payload for the paginated links list. */
const ListLinksResponseSchema = z
  .object({
    items: z.array(LinkResponseSchema),
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
  })
  .passthrough();

export async function registerRegistrationLinksRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/v1/links/create',
    {
      config: { rbac: { capability: 'profiles.onboard' } },
      schema: {
        tags: ['registration-links'],
        summary: 'Create a shareable registration link',
        description:
          'Creates a shareable registration link for the caller aggregator, scoped to a domain (seeker/provider). `domain` and `registration_mode` are validated against the active network config at request time. Drafts are metadata-only; status=live also mints the public URL. The QR is generated client-side from that URL (#650).',
        security: [{ bearerAuth: [] }],
        body: CreateLinkBodySchema,
        response: {
          201: LinkResponseSchema,
          ...errorResponses(400, 401, 403, 500, 503),
        },
      },
    },
    async (req, reply) => {
      const auth = await requireAuth(req);
      const log = req.log.child({
        operation: 'registrationLinks.create',
        actor: auth.userId,
        aggregator_id: auth.aggregatorId,
      });
      const start = Date.now();

      // Validated by the route schema; `expires_at` is a Date or null.
      const body = req.body as z.infer<typeof CreateLinkBodySchema>;
      const networkCfg = await getNetworkConfig();
      if (!networkCfg.domainIds.includes(body.domain)) {
        throw httpError('SCHEMA_VALIDATION', {
          detail: `unknown domain '${body.domain}' — valid: ${networkCfg.domainIds.join(', ')}`,
          fields: { domain: 'invalid' },
        });
      }
      enforceAggregatorType(auth, body.domain);

      const declaredModes = Object.keys(networkCfg.aggregator.registration_modes ?? {});
      // Enforce AGGREGATOR_ONBOARDING_ENABLED here; hiding a mode in the UI is not
      // enough. When unset, every declared mode is enabled.
      const enabledModes = enabledRegistrationModes(declaredModes);
      // No mode given: use `form` if enabled, else the first enabled mode. That can
      // be `voice` (account-only) when `form` is withheld. The response returns the mode used.
      const modeKey =
        body.registration_mode ??
        (enabledModes.includes('form') ? 'form' : enabledModes[0]) ??
        'form';
      if (!enabledModes.includes(modeKey)) {
        throw httpError('INVALID_REGISTRATION_MODE', {
          detail: declaredModes.includes(modeKey)
            ? `registration_mode '${modeKey}' is not enabled for this deployment`
            : `registration_mode '${modeKey}' is not declared for this network`,
          fields: { declared: declaredModes, enabled: enabledModes },
        });
      }
      const store = getRegistrationLinksStore();

      // Try the caller's slug first and add a short random suffix on collision.
      // Without one, use a random stem.
      let created;
      let slug = '';
      for (let attempt = 0; attempt < SLUG_RETRIES; attempt++) {
        if (body.slug) {
          slug = attempt === 0 ? body.slug : `${body.slug}-${randomSuffix()}`;
        } else {
          slug = generateSlug();
        }
        const result = await store.create({
          aggregatorId: auth.aggregatorId,
          slug,
          domain: body.domain,
          context: body.context,
          status: body.status,
          registrationMode: modeKey,
          expiresAt: body.expires_at,
          createdBy: auth.userId,
        });
        if (result.ok) {
          created = result.value;
          break;
        }
        if (result.error.code !== 'SLUG_COLLISION') {
          log.error({
            status: 'failure',
            sub: 'store.create',
            error: result.error.code,
            latency_ms: Date.now() - start,
          });
          throw httpError('DB_UNAVAILABLE', { cause: new Error(result.error.message) });
        }
        log.warn({ status: 'retry', reason: 'slug_collision', attempt, slug });
      }
      if (!created) {
        log.error({
          status: 'failure',
          reason: 'slug_retries_exhausted',
          latency_ms: Date.now() - start,
        });
        throw httpError('DUPLICATE_SLUG', {
          detail: 'Could not allocate a unique slug for the link. Please retry.',
        });
      }

      // Coordinator org_slug for the URL path.
      const userStore = getUserStore();
      const aggLookup = await userStore.findById(auth.aggregatorId);
      if (!aggLookup.ok || !aggLookup.value) {
        throw httpError('DB_UNAVAILABLE', {
          cause: new Error(
            aggLookup.ok ? 'aggregator row missing for caller' : aggLookup.error.message,
          ),
        });
      }
      const callerOrgSlug = aggLookup.value.orgSlug;

      // The public URL exists only once the link is live; a draft slug can still
      // change. The QR is generated client-side from the URL.
      if (created.status === 'draft') {
        log.info({
          status: 'success',
          latency_ms: Date.now() - start,
          link_id: created.id,
          slug: created.slug,
          domain: created.domain,
          link_status: 'draft',
        });
        return reply.code(201).send(await buildResponse(created, callerOrgSlug));
      }

      // status === 'live': activate at create.
      const publicUrl = buildPublicUrl(callerOrgSlug, slug);

      log.info({
        status: 'success',
        latency_ms: Date.now() - start,
        link_id: created.id,
        slug: created.slug,
        domain: created.domain,
      });

      return reply.code(201).send(await buildResponse(created, callerOrgSlug, { publicUrl }));
    },
  );

  app.get(
    '/v1/links',
    {
      config: { rbac: { capability: 'profiles.view' } },
      schema: {
        tags: ['registration-links'],
        summary: "List the caller aggregator's registration links",
        description: 'Paginated list (newest first) of registration links with status + counters.',
        security: [{ bearerAuth: [] }],
        querystring: ListQuerySchema,
        response: {
          200: ListLinksResponseSchema,
          ...errorResponses(400, 401, 403, 503),
        },
      },
    },
    async (req, reply) => {
      const auth = await requireAuth(req);
      const log = req.log.child({
        operation: 'registrationLinks.list',
        actor: auth.userId,
        aggregator_id: auth.aggregatorId,
      });
      const start = Date.now();

      // Validated and defaulted by the route schema.
      const { status, limit, offset } = req.query as z.infer<typeof ListQuerySchema>;

      const orgSlug = await resolveOrgSlug(auth.aggregatorId);
      const result = await getRegistrationLinksStore().list(auth.aggregatorId, {
        ...(status ? { status } : {}),
        limit,
        offset,
      });
      if (!result.ok) {
        throw httpError('DB_UNAVAILABLE', { cause: new Error(result.error.message) });
      }

      // One grouped query for all link metrics, avoiding N+1.
      const metricsById = await fetchLinkMetrics(
        auth.aggregatorId,
        result.value.rows.map((r) => r.id),
      );
      const items = await Promise.all(
        result.value.rows.map((row) =>
          buildResponse(row, orgSlug, { metrics: metricsById.get(row.id) ?? ZERO_METRICS }),
        ),
      );

      log.info({
        status: 'success',
        latency_ms: Date.now() - start,
        total: result.value.total,
        returned: items.length,
      });

      return reply.send({
        items,
        total: result.value.total,
        limit,
        offset,
      });
    },
  );

  app.patch(
    '/v1/links/:id',
    {
      config: { rbac: { capability: 'profiles.onboard' } },
      schema: {
        tags: ['registration-links'],
        summary: 'Update a registration link',
        description:
          'Partial update of mutable draft-link fields (slug, context, expiry). Only draft links can be edited; `registration_mode` and `domain` are immutable and unknown keys are rejected with 400.',
        security: [{ bearerAuth: [] }],
        params: LinkParamsSchema,
        body: UpdateLinkBodySchema,
        response: {
          200: LinkResponseSchema,
          ...errorResponses(400, 401, 403, 409, 503),
        },
      },
    },
    async (req, reply) => {
      const auth = await requireAuth(req);
      // Validated by the route schemas; the `.strict()` schema rejects unknown keys
      // such as registration_mode.
      const { id: linkId } = req.params as z.infer<typeof LinkParamsSchema>;
      const log = req.log.child({
        operation: 'registrationLinks.update',
        actor: auth.userId,
        link_id: linkId,
      });
      const start = Date.now();

      const body = req.body as z.infer<typeof UpdateLinkBodySchema>;

      const store = getRegistrationLinksStore();
      const found = await store.findById(linkId, auth.aggregatorId);
      if (!found.ok) {
        throw httpError('DB_UNAVAILABLE', { cause: new Error(found.error.message) });
      }
      if (!found.value) {
        throw httpError('FORBIDDEN', { detail: 'Link not accessible.' });
      }
      if (found.value.status !== 'draft') {
        throw httpError('CONFLICT', {
          detail: 'Only draft links can be edited. Retire this link and create a new one.',
          fields: { link_status: found.value.status },
        });
      }

      // Same slug retry as create. Without a requested slug, keep the current one.
      let updated;
      let slug = found.value.slug;
      if (body.slug !== undefined) {
        for (let attempt = 0; attempt < SLUG_RETRIES; attempt += 1) {
          slug = attempt === 0 ? body.slug : `${body.slug}-${randomSuffix()}`;
          const result = await store.updateDraft(linkId, auth.aggregatorId, {
            slug,
            ...(body.context !== undefined ? { context: body.context } : {}),
            ...(body.expires_at !== undefined ? { expiresAt: body.expires_at } : {}),
          });
          if (result.ok) {
            updated = result.value;
            break;
          }
          if (result.error.code !== 'SLUG_COLLISION') {
            if (result.error.code === 'NOT_FOUND') {
              throw httpError('CONFLICT', {
                detail: 'Link is no longer a draft — edit blocked.',
              });
            }
            log.error({
              status: 'failure',
              sub: 'store.updateDraft',
              error: result.error.code,
              latency_ms: Date.now() - start,
            });
            throw httpError('DB_UNAVAILABLE', { cause: new Error(result.error.message) });
          }
          log.warn({ status: 'retry', reason: 'slug_collision', attempt, slug });
        }
        if (!updated) {
          log.error({
            status: 'failure',
            reason: 'slug_retries_exhausted',
            latency_ms: Date.now() - start,
          });
          throw httpError('DUPLICATE_SLUG', {
            detail: 'Could not allocate a unique slug for the link. Please retry.',
          });
        }
      } else {
        const result = await store.updateDraft(linkId, auth.aggregatorId, {
          ...(body.context !== undefined ? { context: body.context } : {}),
          ...(body.expires_at !== undefined ? { expiresAt: body.expires_at } : {}),
        });
        if (!result.ok) {
          if (result.error.code === 'NOT_FOUND') {
            throw httpError('CONFLICT', {
              detail: 'Link is no longer a draft — edit blocked.',
            });
          }
          throw httpError('DB_UNAVAILABLE', { cause: new Error(result.error.message) });
        }
        updated = result.value;
      }

      const orgSlug = await resolveOrgSlug(auth.aggregatorId);
      log.info({
        status: 'success',
        latency_ms: Date.now() - start,
        slug: updated.slug,
        slug_changed: body.slug !== undefined,
      });
      return reply.send(await buildResponse(updated, orgSlug));
    },
  );

  app.get(
    '/v1/links/:id',
    {
      config: { rbac: { capability: 'profiles.view' } },
      schema: {
        tags: ['registration-links'],
        summary: 'Read a registration link',
        description: 'Full link row including counters + status.',
        security: [{ bearerAuth: [] }],
        params: LinkParamsSchema,
        response: {
          200: LinkResponseSchema,
          ...errorResponses(400, 401, 403, 503),
        },
      },
    },
    async (req, reply) => {
      const auth = await requireAuth(req);
      // Validated by the route schema.
      const { id: linkId } = req.params as z.infer<typeof LinkParamsSchema>;

      const result = await getRegistrationLinksStore().findById(linkId, auth.aggregatorId);
      if (!result.ok) {
        throw httpError('DB_UNAVAILABLE', { cause: new Error(result.error.message) });
      }
      if (!result.value) {
        // 403 so other aggregators' links cannot be enumerated.
        throw httpError('FORBIDDEN', { detail: 'Link not accessible.' });
      }
      const orgSlug = await resolveOrgSlug(auth.aggregatorId);
      return reply.send(await buildResponse(result.value, orgSlug));
    },
  );

  app.post(
    '/v1/links/:id/activate',
    {
      config: { rbac: { capability: 'profiles.onboard' } },
      schema: {
        tags: ['registration-links'],
        summary: 'Activate a registration link',
        description:
          'Flips the link status to live so the public form accepts submissions and returns the public URL. Idempotent when already live; retired links cannot be reactivated (409).',
        security: [{ bearerAuth: [] }],
        params: LinkParamsSchema,
        response: {
          200: LinkResponseSchema,
          ...errorResponses(400, 401, 403, 409, 500, 503),
        },
      },
    },
    async (req, reply) => {
      const auth = await requireAuth(req);
      // Validated by the route schema.
      const { id: linkId } = req.params as z.infer<typeof LinkParamsSchema>;
      const log = req.log.child({
        operation: 'registrationLinks.activate',
        actor: auth.userId,
        link_id: linkId,
      });
      const start = Date.now();

      const store = getRegistrationLinksStore();
      const found = await store.findById(linkId, auth.aggregatorId);
      if (!found.ok) {
        throw httpError('DB_UNAVAILABLE', { cause: new Error(found.error.message) });
      }
      if (!found.value) {
        throw httpError('FORBIDDEN', { detail: 'Link not accessible.' });
      }

      const orgSlug = await resolveOrgSlug(auth.aggregatorId);
      if (found.value.status === 'live') {
        log.info({ status: 'skipped', reason: 'already_live', latency_ms: Date.now() - start });
        return reply.send(await buildResponse(found.value, orgSlug));
      }
      if (found.value.status === 'retired') {
        throw httpError('CONFLICT', { detail: 'Retired links cannot be reactivated.' });
      }

      // The slug is now fixed, so the public URL is final. The QR is generated client-side.
      const publicUrl = buildPublicUrl(orgSlug, found.value.slug);

      const updated = await store.updateStatus(linkId, auth.aggregatorId, 'live');
      if (!updated.ok) {
        throw httpError('DB_UNAVAILABLE', { cause: new Error(updated.error.message) });
      }

      log.info({
        status: 'success',
        latency_ms: Date.now() - start,
        previous_status: found.value.status,
      });

      return reply.send(await buildResponse(updated.value, orgSlug, { publicUrl }));
    },
  );

  app.post(
    '/v1/links/:id/deactivate',
    {
      config: { rbac: { capability: 'profiles.onboard' } },
      schema: {
        tags: ['registration-links'],
        summary: 'Deactivate a registration link',
        description:
          'Flips status to retired — the public form returns 410 for further submissions. Idempotent when already retired.',
        security: [{ bearerAuth: [] }],
        params: LinkParamsSchema,
        response: {
          200: LinkResponseSchema,
          ...errorResponses(400, 401, 403, 503),
        },
      },
    },
    async (req, reply) => {
      const auth = await requireAuth(req);
      // Validated by the route schema.
      const { id: linkId } = req.params as z.infer<typeof LinkParamsSchema>;
      const log = req.log.child({
        operation: 'registrationLinks.deactivate',
        actor: auth.userId,
        link_id: linkId,
      });
      const start = Date.now();

      const store = getRegistrationLinksStore();
      const found = await store.findById(linkId, auth.aggregatorId);
      if (!found.ok) {
        throw httpError('DB_UNAVAILABLE', { cause: new Error(found.error.message) });
      }
      if (!found.value) {
        throw httpError('FORBIDDEN', { detail: 'Link not accessible.' });
      }

      const orgSlug = await resolveOrgSlug(auth.aggregatorId);
      if (found.value.status === 'retired') {
        log.info({ status: 'skipped', reason: 'already_retired', latency_ms: Date.now() - start });
        return reply.send(await buildResponse(found.value, orgSlug));
      }

      const updated = await store.updateStatus(linkId, auth.aggregatorId, 'retired');
      if (!updated.ok) {
        throw httpError('DB_UNAVAILABLE', { cause: new Error(updated.error.message) });
      }

      log.info({
        status: 'success',
        latency_ms: Date.now() - start,
        previous_status: found.value.status,
      });

      return reply.send(await buildResponse(updated.value, orgSlug));
    },
  );
}

/**
 * Resolves the caller's org_slug, used as a path segment in the public URL.
 */
async function resolveOrgSlug(aggregatorId: string): Promise<string> {
  const result = await getUserStore().findById(aggregatorId);
  if (!result.ok || !result.value) {
    throw httpError('DB_UNAVAILABLE', {
      cause: new Error(result.ok ? 'aggregator row missing for caller' : result.error.message),
    });
  }
  return result.value.orgSlug;
}

interface ResponseOverrides {
  publicUrl?: string;
  metrics?: LinkMetrics;
}

/**
 * Renders a registration link as the API response shape. The public URL is
 * built per request from `org_slug`.
 *
 * `qr_url` / `qr_expires_at` are always `null`; the QR is generated
 * client-side from `public_url`. They will be removed later.
 *
 * @param orgSlug - The owning aggregator's `org_slug`, used in the public URL.
 */
async function buildResponse(
  row: RegistrationLink,
  orgSlug: string,
  overrides: ResponseOverrides = {},
): Promise<Record<string, unknown>> {
  // Drafts and retired links have no public URL.
  const isPublished = row.status === 'live';
  const publicUrl = isPublished ? (overrides.publicUrl ?? buildPublicUrl(orgSlug, row.slug)) : null;
  // No server-side QR URL.
  const qrUrl: string | null = null;
  const qrExpiresAt: string | null = null;
  // List calls pass `metrics` from one grouped query; single reads look them up.
  const metrics =
    overrides.metrics ??
    (await fetchLinkMetrics(row.aggregatorId, [row.id])).get(row.id) ??
    ZERO_METRICS;
  return {
    link_id: row.id,
    slug: row.slug,
    domain: row.domain,
    status: row.status,
    registration_mode: row.registrationMode,
    context: row.context,
    expires_at: row.expiresAt ? row.expiresAt.toISOString() : null,
    public_url: publicUrl,
    qr_url: qrUrl,
    qr_expires_at: qrExpiresAt,
    metrics,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/**
 * Generates the short hex suffix added to a slug on a collision.
 */
function randomSuffix(bytes = 2): string {
  return randomBytes(bytes).toString('hex');
}

/**
 * Generates a random URL-safe slug (16 hex chars). The route still retries on
 * a unique-violation.
 */
function generateSlug(): string {
  return randomBytes(8).toString('hex');
}

/**
 * Builds the public URL for a link: `${base}/<org_slug>/<slug>`.
 */
function buildPublicUrl(orgSlug: string, slug: string): string {
  const base = stripTrailingSlashes(config.PUBLIC_LINK_BASE_URL);
  return `${base}/${orgSlug}/${slug}`;
}

async function requireAuth(req: FastifyRequest): Promise<AuthContext> {
  const result = await requireApproved(req);
  if (!result.ok) {
    if (result.error.code === 'NOT_APPROVED') {
      throw httpError('NOT_APPROVED', { detail: result.error.message });
    }
    throw httpError('UNAUTHORIZED', { detail: result.error.message });
  }
  if (!result.context.aggregatorId) {
    throw httpError('UNAUTHORIZED', { detail: 'Token missing aggregator_id claim.' });
  }
  await recordRouteCaller(req, callerFromAuth(result.context));
  return result.context;
}

/**
 * Rejects a link domain (seeker | provider) that does not match the
 * aggregator's registered type (`aggregator_type` claim).
 */
function enforceAggregatorType(auth: AuthContext, domain: string): void {
  if (!auth.aggregatorType) {
    throw httpError('AGGREGATOR_TYPE_MISSING', {
      fields: { aggregator_id: auth.aggregatorId },
    });
  }
  if (auth.aggregatorType !== domain) {
    throw httpError('AGGREGATOR_TYPE_MISMATCH', {
      fields: {
        aggregator_type: auth.aggregatorType,
        requested_type: domain,
      },
    });
  }
}
