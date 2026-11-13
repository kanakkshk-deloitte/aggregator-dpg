/**
 * Dashboard endpoints of the aggregator API (`@aggregator-dpg/api`).
 *
 *   GET /v1/dashboard?domain&page&limit&status
 *     Proxies signalstack's dashboard payload (rollup, paginated participants,
 *     cursor, metadata) for the caller's signalstack org.
 *
 * Authorisation: Bearer access token with the `aggregator_id` claim.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { errorResponses } from '../errors/openapi.js';
import { requireApproved, type AuthContext } from '../services/auth/access-token.js';
import { getUserStore } from '../services/user-store/index.js';
import { getNetworkConfig } from '../services/network-config.js';
import { getSignalStackWriter } from '../services/signalstack.js';
import type { SignalStackDecryptedProfileRow } from '@aggregator-dpg/signalstack-writer/interface';
import { buildDecryptedProfilesCsv } from '@aggregator-dpg/profile-csv';
import { httpError } from '../errors/http-error.js';
import { callerFromAuth, recordRouteCaller } from '../services/authz/index.js';

/**
 * Lifecycle statuses the dashboard shows. Paused and retired are excluded.
 */
const DASHBOARD_LIFECYCLE = ['draft', 'live'] as const;

/**
 * Max `item_ids` accepted by the decrypted-profile export in one call.
 *
 * Caps how many profiles one request can decrypt. Larger than any dashboard page.
 */
const EXPORT_MAX_ITEM_IDS = 1000;

/**
 * Dashboard query schema.
 *
 * `status` is only shape-checked; signalstack owns the set of valid values.
 * `domain` defaults to the first configured domain.
 */
const DashboardQuerySchema = z.object({
  domain: z.string().min(1).optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  status: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9_]+$/i, 'status must be alphanumeric + underscore')
    .optional(),
  /**
   * Narrows the participant list to one lifecycle, filtered and paginated upstream.
   * When absent, {@link DASHBOARD_LIFECYCLE} is used.
   */
  lifecycle: z.enum(['draft', 'live']).optional(),
  /** Bypass signalstack's TTL cache when true. Forwarded verbatim. */
  refresh: z.coerce.boolean().optional().default(false),
});

/**
 * Export query schema. A subset of {@link DashboardQuerySchema}; only `status` filters.
 * The handler checks `domain` against the network config.
 */
const DashboardExportQuerySchema = z.object({
  domain: z.string().min(1).optional(),
  status: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9_]+$/i, 'status must be alphanumeric + underscore')
    .optional(),
  refresh: z.coerce.boolean().optional().default(false),
});

const ExportProfilesBodySchema = z.object({
  item_ids: z.array(z.string().min(1)).min(1).max(EXPORT_MAX_ITEM_IDS),
  domain: z.string().min(1).optional(),
});

export async function registerDashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/v1/dashboard',
    {
      config: { rbac: { capability: 'profiles.view' } },
      schema: {
        tags: ['dashboard'],
        summary: 'Aggregator dashboard rollup + items',
        description:
          "Proxies signalstack's pre-computed dashboard payload (rollup + paginated participants + cursor + metadata) for the caller aggregator. by_domain[<id>] contains seeker/provider slices; refresh=true bypasses the TTL cache. The 200 payload is proxied verbatim from signalstack, so no response schema is pinned (avoids a deep zod re-parse of the rollup on every reply).",
        security: [{ bearerAuth: [] }],
        querystring: DashboardQuerySchema,
        // 200 carries no schema on purpose — see description.
        response: { ...errorResponses(400, 401, 403, 500, 503) },
      },
    },
    async (req, reply) => {
      const auth = await requireApprovedAuth(req);
      const log = req.log.child({
        operation: 'dashboard',
        aggregator_id: auth.aggregatorId,
      });
      const start = Date.now();

      // Validated (and defaulted) by the route's `querystring` zod schema.
      const query = req.query as z.infer<typeof DashboardQuerySchema>;
      const { page, limit, status, lifecycle, refresh } = query;
      const networkCfg = await getNetworkConfig();
      const domain = query.domain ?? networkCfg.domainIds[0]!;
      if (!networkCfg.domains[domain]) {
        throw httpError('SCHEMA_VALIDATION', {
          detail: `unknown domain '${domain}' — valid: ${networkCfg.domainIds.join(', ')}`,
        });
      }

      const ss = getSignalStackWriter();
      if (!ss) {
        log.warn({ status: 'failure', sub: 'signalstack.disabled' });
        throw httpError('INTERNAL', {
          detail: 'Signalstack is not configured for this environment.',
        });
      }

      const actingOrgId = await resolveActingOrgId(auth, log);

      const result = await ss.fetchDashboard({
        actingOrgId,
        requestId: req.id,
        page,
        limit,
        ...(status ? { status } : {}),
        domain,
        // Draft + live by default; `?lifecycle=` narrows to one.
        lifecycle: lifecycle ? [lifecycle] : DASHBOARD_LIFECYCLE,
        refresh,
      });

      if (!result.success) {
        log.error({
          status: 'failure',
          sub: 'signalstack.dashboard',
          error: result.error.message,
          code: result.error.code,
        });
        throw httpError('INTERNAL', {
          detail: `Signalstack dashboard fetch failed: ${result.error.code}`,
          cause: result.error,
        });
      }

      // The payload holds every domain under `by_domain`; log the requested
      // domain's slice and forward the payload unchanged.
      const slice = result.value.by_domain[domain];
      log.info({
        status: 'success',
        latency_ms: Date.now() - start,
        domain,
        page,
        limit,
        status_filter: status ?? null,
        total_matching: slice?.total_matching ?? null,
        items_total: slice?.rollup.total_items ?? null,
        refreshed: result.value.metadata.refreshed,
      });

      return reply.send(result.value);
    },
  );

  app.get(
    '/v1/dashboard/export',
    {
      config: { rbac: { capability: 'profiles.export' } },
      schema: {
        tags: ['dashboard'],
        summary: 'CSV export of dashboard items',
        description:
          'Returns a CSV (text/csv) of the dashboard items for the caller aggregator. Filters by optional status. Body is the CSV text, with Content-Disposition: attachment.',
        security: [{ bearerAuth: [] }],
        querystring: DashboardExportQuerySchema,
        // 200 carries no schema — the reply is a text/csv attachment.
        response: { ...errorResponses(400, 401, 403, 500, 503) },
      },
    },
    async (req, reply) => {
      const auth = await requireApprovedAuth(req);
      const log = req.log.child({
        operation: 'dashboard.export',
        aggregator_id: auth.aggregatorId,
      });
      const start = Date.now();

      // Validated (and defaulted) by the route's `querystring` zod schema.
      const query = req.query as z.infer<typeof DashboardExportQuerySchema>;
      const { status, refresh } = query;
      const networkCfg = await getNetworkConfig();
      const domain = query.domain ?? networkCfg.domainIds[0]!;
      if (!networkCfg.domains[domain]) {
        throw httpError('SCHEMA_VALIDATION', {
          detail: `unknown domain '${domain}' — valid: ${networkCfg.domainIds.join(', ')}`,
        });
      }

      const ss = getSignalStackWriter();
      if (!ss) {
        log.warn({ status: 'failure', sub: 'signalstack.disabled' });
        throw httpError('INTERNAL', {
          detail: 'Signalstack is not configured for this environment.',
        });
      }

      const actingOrgId = await resolveActingOrgId(auth, log);

      const result = await ss.exportDashboardCsv({
        actingOrgId,
        requestId: req.id,
        ...(status ? { status } : {}),
        domain,
        refresh,
      });

      if (!result.success) {
        log.error({
          status: 'failure',
          sub: 'signalstack.dashboard.export',
          error: result.error.message,
          code: result.error.code,
        });
        throw httpError('INTERNAL', {
          detail: `Signalstack dashboard export failed: ${result.error.code}`,
          cause: result.error,
        });
      }

      log.info({
        status: 'success',
        latency_ms: Date.now() - start,
        domain,
        status_filter: status ?? null,
        bytes: result.value.csv.length,
        filename: result.value.filename,
      });

      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header(
          'Content-Disposition',
          `attachment; filename="${result.value.filename.replaceAll('"', '')}"`,
        )
        .send(result.value.csv);
    },
  );

  app.post(
    '/v1/dashboard/export/profiles',
    {
      config: { rbac: { capability: 'profiles.view_pii' } },
      schema: {
        tags: ['dashboard'],
        summary: 'CSV export of DECRYPTED profile data for selected items',
        description:
          'Returns a CSV (text/csv) of decrypted profile data for the given item_ids, scoped to the caller aggregator. The signalstack admin key never leaves the server.',
        security: [{ bearerAuth: [] }],
        body: ExportProfilesBodySchema,
        response: { ...errorResponses(400, 401, 403, 500, 503) },
      },
    },
    async (req, reply) => {
      const auth = await requireApprovedAuth(req);
      const log = req.log.child({
        operation: 'dashboard.export.profiles',
        aggregator_id: auth.aggregatorId,
      });
      const start = Date.now();

      const { item_ids, domain: requestedDomain } = req.body as z.infer<
        typeof ExportProfilesBodySchema
      >;
      const networkCfg = await getNetworkConfig();
      const domain = requestedDomain ?? networkCfg.domainIds[0]!;
      if (!networkCfg.domains[domain]) {
        throw httpError('SCHEMA_VALIDATION', {
          detail: `unknown domain '${domain}' — valid: ${networkCfg.domainIds.join(', ')}`,
        });
      }

      const ss = getSignalStackWriter();
      if (!ss) {
        log.warn({ status: 'failure', sub: 'signalstack.disabled' });
        throw httpError('INTERNAL', {
          detail: 'Signalstack is not configured for this environment.',
        });
      }

      const actingOrgId = await resolveActingOrgId(auth, log);

      // Deduplicate so repeated ids do not count against EXPORT_MAX_ITEM_IDS.
      // Order is preserved, so CSV rows follow the request.
      const requestedIds = [...new Set(item_ids)];

      const result = await ss.fetchDecryptedProfiles({
        actingOrgId,
        itemIds: requestedIds,
        requestId: req.id,
      });
      if (!result.success) {
        log.error({
          status: 'failure',
          sub: 'signalstack.profiles.decrypt',
          error: result.error.message,
          code: result.error.code,
        });
        throw httpError('INTERNAL', {
          detail: `Signalstack profile decrypt failed: ${result.error.code}`,
          cause: result.error,
        });
      }

      const rows: SignalStackDecryptedProfileRow[] = result.value.profiles;
      const csv = buildDecryptedProfilesCsv(rows);
      const filename = `profiles-${domain}-${new Date().toISOString().slice(0, 10)}.csv`;

      // Signals decrypts only ids this org onboarded in its domains; the rest
      // come back in `skipped`. The UI only sends ids it listed, so a non-zero
      // count means a client bug or probing. Log counts only, never ids or item_state.
      const skippedCount = result.value.skipped.length;
      if (skippedCount > 0) {
        log.warn({
          status: 'success',
          sub: 'decrypt.unowned_ids_requested',
          domain,
          requested: requestedIds.length,
          returned: rows.length,
          skipped: skippedCount,
        });
      }

      // Do NOT log item_state values (PII). Counts only.
      log.info({
        status: 'success',
        latency_ms: Date.now() - start,
        domain,
        requested: requestedIds.length,
        returned: rows.length,
        skipped: skippedCount,
        bytes: csv.length,
      });

      // Withheld rows are dropped, not rejected, so the response does not reveal
      // ids that exist elsewhere. The count header makes the drop visible.
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('X-Export-Skipped-Count', String(skippedCount))
        .header('Content-Disposition', `attachment; filename="${filename.replaceAll('"', '')}"`)
        .send(csv);
    },
  );
}

/**
 * Resolves the caller's signalstack organisation id.
 *
 * Uses the access-token claim, else the stored user row (covers a token issued
 * before approval).
 *
 * @param auth - The approved caller.
 * @param log - Request logger.
 * @returns The signalstack org id.
 * @throws DB_UNAVAILABLE if the store read fails.
 * @throws SIGNALSTACK_ORG_NOT_REGISTERED if neither source has a value.
 */
async function resolveActingOrgId(auth: AuthContext, log: FastifyRequest['log']): Promise<string> {
  let actingOrgId: string | null = auth.signalstackOrgId ?? null;
  if (!actingOrgId) {
    const row = await getUserStore().findById(auth.aggregatorId);
    if (!row.ok) {
      log.error({
        status: 'failure',
        sub: 'userStore.findById',
        code: row.error.code,
      });
      throw httpError('DB_UNAVAILABLE', {
        fields: { sub_operation: 'userStore.findById' },
      });
    }
    actingOrgId = row.value?.signalstackOrgId ?? null;
  }
  if (!actingOrgId) {
    log.warn({ status: 'failure', sub: 'signalstack.org_not_registered' });
    throw httpError('SIGNALSTACK_ORG_NOT_REGISTERED', {
      fields: { aggregator_id: auth.aggregatorId },
    });
  }
  return actingOrgId;
}

/**
 * Authenticates an approved coordinator and checks route access.
 *
 * A missing `aggregator_id` claim is 403 FORBIDDEN; a coordinator not yet
 * approved is 403 NOT_APPROVED.
 */
async function requireApprovedAuth(req: FastifyRequest): Promise<AuthContext> {
  const result = await requireApproved(req);
  if (result.ok) {
    await recordRouteCaller(req, callerFromAuth(result.context));
    return result.context;
  }
  if (result.error.code === 'MISSING_AGGREGATOR_ID') {
    throw httpError('FORBIDDEN', {
      detail: result.error.message,
      fields: { reason: result.error.code },
    });
  }
  if (result.error.code === 'NOT_APPROVED') {
    throw httpError('NOT_APPROVED', {
      detail: result.error.message,
      fields: { reason: result.error.code },
    });
  }
  throw httpError('UNAUTHORIZED', {
    detail: result.error.message,
    fields: { reason: result.error.code },
  });
}
