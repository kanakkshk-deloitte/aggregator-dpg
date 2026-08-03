/**
 * Public identity-probe endpoint for the registration form.
 *
 *   GET /public/v1/aggregators/:orgSlug/lookup?email&phone_number&network&domain
 *
 * No JWT — same anonymous access model as the public registration link
 * resolve route. Aggregator scope comes from the `orgSlug` path segment;
 * the signalstack probe runs under that aggregator's `signalstack_org_id`
 * (no item ever created — signals' `submit_mode: account_only` path).
 *
 * Reshapes the writer's `SignalStackProbeUserResult` into the wire payload
 * the BFF consumes to decide between "open the form fresh" / "resume
 * lifecycle" / "show already-registered-elsewhere" branches.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getAggregatorStore } from '../services/aggregator-store/index.js';
import { getSignalStackWriter } from '../services/signalstack.js';
import { normalisePhone } from '../services/phone.js';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';
import { consume } from '../services/rate-limiter/index.js';
import { config } from '../config.js';

interface OrgSlugParams {
  orgSlug?: string;
}

const ParamsSchema = z.object({
  orgSlug: z.string().min(1).describe('Aggregator organisation slug.'),
});

const QuerySchema = z
  .object({
    email: z.string().trim().email().optional(),
    phone_number: z.string().trim().min(1).optional(),
    network: z.string().trim().min(1),
    domain: z.string().trim().min(1),
  })
  .refine((v) => Boolean(v.email) || Boolean(v.phone_number), {
    message: 'Either email or phone_number is required.',
  });

/** Wire shape of the signalstack identity probe forwarded verbatim to the BFF. */
const LookupResponseSchema = z
  .object({
    user_exists: z.boolean(),
    owned_elsewhere: z.boolean(),
    lifecycle_summary: z
      .object({
        primary_item: z
          .object({
            item_id: z.string(),
            lifecycle_status: z.enum(['draft', 'live', 'paused']),
          })
          .passthrough(),
      })
      .passthrough()
      .nullable(),
  })
  .passthrough();

/**
 * Registers the public lookup route on the Fastify instance.
 *
 * Idempotent and anonymous. Returns 200 with the canonical probe payload
 * on success, 400 when neither identity is supplied, 404 when the
 * aggregator slug is unknown (or has not completed the signalstack
 * handshake), 429 when the per-org rate limit trips, and 502 when
 * signalstack returns an error.
 */
export async function registerPublicLookupRoute(app: FastifyInstance): Promise<void> {
  app.get(
    '/public/v1/aggregators/:orgSlug/lookup',
    {
      schema: {
        tags: ['public-registration'],
        summary: 'Probe an identity before opening the registration form',
        description:
          'Anonymous identity probe used by the public registration form. Classifies the supplied email/phone as new (user_exists=false), an own user with optional lifecycle summary, or owned by another aggregator (owned_elsewhere=true). Requires at least one of email or phone_number, plus the network and domain to scope the signalstack probe.',
        params: ParamsSchema,
        querystring: QuerySchema,
        response: {
          200: LookupResponseSchema,
          ...errorResponses(400, 404, 429, 502, 503),
        },
      },
    },
    async (req, reply) => {
      const { orgSlug } = req.params as OrgSlugParams;
      if (!orgSlug) {
        throw httpError('SCHEMA_VALIDATION', { detail: 'orgSlug is required.' });
      }
      const log = req.log.child({ operation: 'public.lookup', org_slug: orgSlug });
      const start = Date.now();

      // Reuse the same window/max as the link-submit limiter — the lookup is
      // a cheaper read but still exposed unauthenticated, so we keep a
      // coarse fallback in case the BFF Turnstile gate is misconfigured.
      const ip = (req.ip ?? '0.0.0.0').toString();
      const rate = await consume({
        namespace: 'public-lookup',
        key: `${orgSlug}:${ip}`,
        windowSeconds: config.PUBLIC_SUBMIT_RATE_WINDOW_SECONDS,
        max: config.PUBLIC_SUBMIT_RATE_MAX_PER_WINDOW,
      });
      if (!rate.allowed) {
        void reply.header('Retry-After', String(rate.retryAfterSeconds));
        log.warn({ status: 'rate_limited', count: rate.count, ip });
        throw httpError('RATE_LIMITED', {
          detail: `Retry in ${rate.retryAfterSeconds}s.`,
        });
      }

      // Validated by the route's `querystring` zod schema, including the
      // either-email-or-phone refine (refinements run in route validation).
      const q = req.query as z.infer<typeof QuerySchema>;

      // Resolve the aggregator's signalstack org id by slug. Absent slug or
      // missing signalstack_org_id both surface as 404 — the lookup
      // endpoint is opaque about whether a given slug exists yet, by
      // design (anonymous enumeration prevention).
      const aggLookup = await getAggregatorStore().findBySlug(orgSlug);
      if (!aggLookup.ok) {
        throw httpError('DB_UNAVAILABLE', {
          fields: { sub_operation: 'aggregatorStore.findBySlug' },
        });
      }
      if (!aggLookup.value || !aggLookup.value.signalstackOrgId) {
        log.warn({ status: 'failure', sub: 'aggregator.not_found' });
        throw httpError('NOT_FOUND', { detail: 'Unknown aggregator.' });
      }
      const actingOrgId = aggLookup.value.signalstackOrgId;

      // Normalise phone to E.164 before forwarding so signals matches the
      // same canonical form the onboard path writes. Empty/invalid input
      // falls through as a 400 rather than a silent miss.
      let phoneNumber: string | undefined;
      if (q.phone_number) {
        const normalised = normalisePhone(q.phone_number);
        if (!normalised.ok) {
          throw httpError('INVALID_PHONE', { detail: normalised.error.message });
        }
        phoneNumber = normalised.value;
      }

      const ss = getSignalStackWriter();
      if (!ss) {
        // Operator hasn't configured signalstack — without it we can't
        // answer the probe truthfully. Surface as 503 so the BFF can
        // distinguish from a 404 "unknown aggregator".
        log.error({ status: 'failure', sub: 'signalstack.disabled' });
        throw httpError('SIGNALSTACK_ORG_NOT_REGISTERED', {
          detail: 'Signalstack integration is not configured.',
        });
      }

      const probe = await ss.probeUser({
        actingOrgId,
        requestId: req.id,
        ...(q.email ? { email: q.email } : {}),
        ...(phoneNumber ? { phoneNumber } : {}),
        network: q.network,
        domain: q.domain,
      });

      if (!probe.success) {
        log.error({
          status: 'failure',
          sub: 'signalstack.probe',
          latency_ms: Date.now() - start,
          error: probe.error.message,
          error_type: probe.error.constructor.name,
        });
        throw httpError('SIGNALSTACK_PROBE_FAILED', {
          detail: probe.error.message,
          fields: { code: (probe.error as { code?: string }).code ?? 'UNKNOWN' },
          cause: probe.error,
        });
      }

      log.info({
        status: 'success',
        latency_ms: Date.now() - start,
        user_exists: probe.value.user_exists,
        owned_elsewhere: probe.value.owned_elsewhere,
        has_lifecycle: probe.value.lifecycle_summary !== null,
      });
      return reply.send(probe.value);
    },
  );
}
