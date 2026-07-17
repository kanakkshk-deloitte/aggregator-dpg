/**
 * Contact-support endpoints (post-login).
 *
 *   GET  /v1/support/config → { enabled }   — whether SUPPORT_EMAIL is set.
 *   POST /v1/support        → emails the submission to SUPPORT_EMAIL.
 *
 * Any authenticated coordinator may submit — approval status is
 * intentionally not required (an aggregator awaiting approval may still
 * need to contact support). Belongs to `@aggregator-dpg/api`.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, type AuthContext } from '../services/auth/access-token.js';
import { getMailer } from '../services/mailer/index.js';
import {
  renderSupportRequest,
  generateSupportReference,
  getEmailBrand,
} from '../services/email-templates/index.js';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';
import { supportEmail, supportCc, supportPortalLink } from '../config.js';

const SupportRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    email: z.string().email().max(320).optional(),
    phone: z.string().min(3).max(20).optional(),
    type: z.enum(['complaint', 'support_request']),
    details: z.string().trim().min(1).max(5000),
    consent: z.literal(true),
  })
  .strict()
  // At least one contact channel is required so support can reply. A failed
  // refine surfaces as a 400 SCHEMA_VALIDATION envelope via the global error
  // handler (see app.ts), consistent with every other zod body rejection.
  .refine((body) => Boolean(body.email) || Boolean(body.phone), {
    message: 'Provide at least one of email or phone so support can reach you.',
    path: ['email'],
  });

/**
 * Registers the contact-support routes on the given Fastify instance.
 *
 * @param app - The Fastify instance to attach routes to.
 */
export async function registerSupportRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/v1/support/config',
    {
      schema: {
        tags: ['support'],
        summary: 'Whether the contact-support form is enabled',
        description:
          'Reports whether SUPPORT_EMAIL is configured on this instance. The web app hides the "Contact support" entry point when false.',
        security: [{ bearerAuth: [] }],
        response: { 200: z.object({ enabled: z.boolean() }), ...errorResponses(401) },
      },
    },
    async (req, reply) => {
      await requireAuth(req);
      return reply.send({ enabled: Boolean(supportEmail()) });
    },
  );

  app.post(
    '/v1/support',
    {
      schema: {
        tags: ['support'],
        summary: 'Send a contact-support message',
        description:
          'Emails the submitted complaint/support request to SUPPORT_EMAIL (and SUPPORT_CC_EMAIL when set), with Reply-To set to the submitter email so support can reply directly. Each submission carries a SUP-YYYYMMDD-XXXXXX reference.',
        security: [{ bearerAuth: [] }],
        body: SupportRequestSchema,
        response: {
          201: z.object({ ok: z.boolean(), reference: z.string() }),
          ...errorResponses(400, 401, 502, 503),
        },
      },
    },
    async (req, reply) => {
      const auth = await requireAuth(req);
      const log = req.log.child({ operation: 'support.submit', actor: auth.userId });
      const start = Date.now();

      const recipient = supportEmail();
      if (!recipient) {
        throw httpError('SUPPORT_NOT_CONFIGURED');
      }

      // Validated by the route's `body` zod schema. Use the SUBMITTED
      // name/email/phone — the web form prefills them from the session but
      // lets the coordinator correct them before sending.
      const { name, email, phone, type, details } = req.body as z.infer<
        typeof SupportRequestSchema
      >;
      const reference = generateSupportReference();
      const rendered = renderSupportRequest({
        type,
        name,
        email: email ?? null,
        phone: phone ?? null,
        details,
        reference,
        link: supportPortalLink(),
        // Brand short-name seeded from config-loader at server boot
        // (setEmailBrand); falls back to the generic default under test.
        teamName: getEmailBrand().short_name,
        submittedAt: new Date(),
      });

      const cc = supportCc();
      const sent = await getMailer().send({
        to: recipient,
        ...(cc ? { cc } : {}),
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        ...(email ? { replyTo: email } : {}),
      });

      if (!sent.ok) {
        log.error({
          status: 'failure',
          latency_ms: Date.now() - start,
          error: sent.error.message,
          error_type: sent.error.code,
          reference,
        });
        throw httpError('SUPPORT_SEND_FAILED', { cause: new Error(sent.error.message) });
      }

      log.info({
        status: 'success',
        latency_ms: Date.now() - start,
        aggregator_id: auth.aggregatorId,
        reference,
      });
      return reply.code(201).send({ ok: true, reference });
    },
  );
}

/** Unwrap the auth context or throw the catalogue error. Mirrors the local helper in other route modules (e.g. `dashboard.ts`, `aggregator-profile.ts`). */
async function requireAuth(req: FastifyRequest): Promise<AuthContext> {
  const result = await authenticate(req);
  if (result.ok) return result.context;
  const code = result.error.code === 'MISSING_AGGREGATOR_ID' ? 'FORBIDDEN' : 'UNAUTHORIZED';
  throw httpError(code, {
    detail: result.error.message,
    fields: { reason: result.error.code },
  });
}
