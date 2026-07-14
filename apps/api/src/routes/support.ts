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
import { renderSupportRequest } from '../services/email-templates/index.js';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';
import { supportEmail } from '../config.js';

const SupportRequestSchema = z
  .object({
    subject: z.string().max(200).optional(),
    message: z.string().min(1).max(5000),
  })
  .strict();

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
          'Emails the submitted subject/message to SUPPORT_EMAIL, with Reply-To set to the submitter so support can reply directly.',
        security: [{ bearerAuth: [] }],
        body: SupportRequestSchema,
        response: { 201: z.object({ ok: z.boolean() }), ...errorResponses(400, 401, 502, 503) },
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

      // Validated by the route's `body` zod schema.
      const { subject, message } = req.body as z.infer<typeof SupportRequestSchema>;
      const email = renderSupportRequest({
        ...(subject !== undefined ? { subject } : {}),
        message,
        name: auth.preferredUsername ?? auth.email ?? auth.userId,
        email: auth.email ?? null,
        phone: auth.phoneNumber ?? null,
        userId: auth.userId,
        aggregatorId: auth.aggregatorId,
        submittedAt: new Date(),
      });

      const sent = await getMailer().send({
        to: recipient,
        subject: email.subject,
        html: email.html,
        text: email.text,
        ...(auth.email ? { replyTo: auth.email } : {}),
      });

      if (!sent.ok) {
        log.error({
          status: 'failure',
          latency_ms: Date.now() - start,
          error: sent.error.message,
          error_type: sent.error.code,
        });
        throw httpError('SUPPORT_SEND_FAILED', { cause: new Error(sent.error.message) });
      }

      log.info({
        status: 'success',
        latency_ms: Date.now() - start,
        aggregator_id: auth.aggregatorId,
      });
      return reply.code(201).send({ ok: true });
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
