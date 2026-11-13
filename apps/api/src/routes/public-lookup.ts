/**
 * Public identity-probe endpoint for the registration form, in the aggregator
 * API (`@aggregator-dpg/api`).
 *
 *   GET /public/v1/aggregators/:orgSlug/lookup?email&phone_number&network&domain
 *
 * Anonymous. The probe runs under the `orgSlug` coordinator's signalstack org
 * and creates no item. The BFF uses the result to open a fresh form, resume a
 * profile, or show "already registered elsewhere".
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getUserStore } from '../services/user-store/index.js';
import { getSignalStackWriter } from '../services/signalstack.js';
import { normalisePhone } from '@aggregator-dpg/shared-primitives/phone';
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
 * Registers the public lookup route.
 *
 * Returns 200 with the probe payload, 400 when no identity is given, 404 for an
 * unknown slug or one with no signalstack org, 429 on rate limit, and 502 when
 * signalstack fails.
 *
 * @param app - Fastify instance.
 */
export async function registerPublicLookupRoute(app: FastifyInstance): Promise<void> {
  app.get(
    '/public/v1/aggregators/:orgSlug/lookup',
    {
      config: { rbac: { access: 'public' } },
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

      // Same limit as link submit; a fallback if the BFF Turnstile check is off.
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

      // Validated by the route's `querystring` schema, including email-or-phone.
      const q = req.query as z.infer<typeof QuerySchema>;

      // Unknown slug and missing signalstack org both answer 404, so slugs
      // cannot be enumerated.
      const aggLookup = await getUserStore().findBySlug(orgSlug);
      if (!aggLookup.ok) {
        throw httpError('DB_UNAVAILABLE', {
          fields: { sub_operation: 'userStore.findBySlug' },
        });
      }
      if (!aggLookup.value || !aggLookup.value.signalstackOrgId) {
        log.warn({ status: 'failure', sub: 'aggregator.not_found' });
        throw httpError('NOT_FOUND', { detail: 'Unknown aggregator.' });
      }
      const actingOrgId = aggLookup.value.signalstackOrgId;

      // Normalise to E.164, the form onboarding writes. Invalid input is a 400.
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
        // Signalstack not configured: 503, distinct from a 404 unknown slug.
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
