/**
 * Onboarding metrics endpoints of the aggregator API (`@aggregator-dpg/api`).
 *
 *   GET /v1/onboarding/summary       totals across both sources
 *   GET /v1/onboarding/by-source     bulk vs link breakdown
 *
 * Reads only from the `onboarding` rollup table. Bulk rows are written by
 * the Finaliser (one per upload). Link rows are written by the Metrics
 * Coordinator (one per (aggregator, link, hour-bucket)).
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requireApproved, type AuthContext } from '../services/auth/access-token.js';
import { getDb } from '../db/client.js';
import { onboarding } from '../db/schema.js';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';
import { callerFromAuth, recordRouteCaller } from '../services/authz/index.js';

const RangeQuerySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

/** Shared counter columns summed from the onboarding rollup table. */
const OnboardingCountersSchema = z.object({
  total: z.number().int(),
  passed: z.number().int(),
  failed: z.number().int(),
  skipped: z.number().int(),
});

const OnboardingSummaryResponseSchema = OnboardingCountersSchema.extend({
  aggregator_id: z.string(),
  from: z.string().nullable(),
  to: z.string().nullable(),
}).passthrough();

const OnboardingBySourceResponseSchema = z
  .object({
    aggregator_id: z.string(),
    from: z.string().nullable(),
    to: z.string().nullable(),
    by_source: z.array(OnboardingCountersSchema.extend({ source: z.string() }).passthrough()),
  })
  .passthrough();

export async function registerOnboardingRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/v1/onboarding/summary',
    {
      config: { rbac: { capability: 'profiles.view' } },
      schema: {
        tags: ['onboarding'],
        summary: 'Aggregated onboarding totals',
        description:
          'Sum of total / passed / failed / skipped onboarding attempts for the caller aggregator, optionally constrained by ?from=&to= ISO dates.',
        security: [{ bearerAuth: [] }],
        querystring: RangeQuerySchema,
        response: {
          200: OnboardingSummaryResponseSchema,
          ...errorResponses(400, 401, 403),
        },
      },
    },
    async (req, reply) => {
      const auth = await requireAuth(req);
      const range = parseRange(req.query as z.infer<typeof RangeQuerySchema>);
      const conditions = [eq(onboarding.userId, auth.aggregatorId)];
      if (range.from) conditions.push(gte(onboarding.periodStart, range.from));
      if (range.to) conditions.push(lte(onboarding.periodEnd, range.to));

      const rows = await getDb()
        .select({
          total: sql<number>`COALESCE(SUM(${onboarding.total}), 0)::int`,
          passed: sql<number>`COALESCE(SUM(${onboarding.passed}), 0)::int`,
          failed: sql<number>`COALESCE(SUM(${onboarding.failed}), 0)::int`,
          skipped: sql<number>`COALESCE(SUM(${onboarding.skipped}), 0)::int`,
        })
        .from(onboarding)
        .where(and(...conditions));

      const r = rows[0] ?? { total: 0, passed: 0, failed: 0, skipped: 0 };
      return reply.send({
        aggregator_id: auth.aggregatorId,
        from: range.from?.toISOString() ?? null,
        to: range.to?.toISOString() ?? null,
        ...r,
      });
    },
  );

  app.get(
    '/v1/onboarding/by-source',
    {
      config: { rbac: { capability: 'profiles.view' } },
      schema: {
        tags: ['onboarding'],
        summary: 'Onboarding totals grouped by source',
        description:
          'Per-source breakdown of onboarding counters for the caller aggregator (e.g. by_link / by_bulk_upload), optionally date-bounded by ?from=&to=.',
        security: [{ bearerAuth: [] }],
        querystring: RangeQuerySchema,
        response: {
          200: OnboardingBySourceResponseSchema,
          ...errorResponses(400, 401, 403),
        },
      },
    },
    async (req, reply) => {
      const auth = await requireAuth(req);
      const range = parseRange(req.query as z.infer<typeof RangeQuerySchema>);
      const conditions = [eq(onboarding.userId, auth.aggregatorId)];
      if (range.from) conditions.push(gte(onboarding.periodStart, range.from));
      if (range.to) conditions.push(lte(onboarding.periodEnd, range.to));

      const rows = await getDb()
        .select({
          source: onboarding.source,
          total: sql<number>`COALESCE(SUM(${onboarding.total}), 0)::int`,
          passed: sql<number>`COALESCE(SUM(${onboarding.passed}), 0)::int`,
          failed: sql<number>`COALESCE(SUM(${onboarding.failed}), 0)::int`,
          skipped: sql<number>`COALESCE(SUM(${onboarding.skipped}), 0)::int`,
        })
        .from(onboarding)
        .where(and(...conditions))
        .groupBy(onboarding.source);

      return reply.send({
        aggregator_id: auth.aggregatorId,
        from: range.from?.toISOString() ?? null,
        to: range.to?.toISOString() ?? null,
        by_source: rows,
      });
    },
  );
}

/**
 * Converts the validated `?from=&to=` query into Date bounds.
 *
 * @param query - The zod-validated range query from `req.query`.
 * @returns Optional from/to Date bounds.
 */
function parseRange(query: z.infer<typeof RangeQuerySchema>): { from?: Date; to?: Date } {
  const out: { from?: Date; to?: Date } = {};
  if (query.from) out.from = new Date(query.from);
  if (query.to) out.to = new Date(query.to);
  return out;
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
