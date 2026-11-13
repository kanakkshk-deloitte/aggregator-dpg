/**
 * Coordinator-invite mint endpoint of the aggregator API (`@aggregator-dpg/api`).
 *
 *   POST /admin/v1/invites   body { grant, recipients[] }
 *     Authed by the owner grant token. Outcomes:
 *       - valid grant: mint one 14-day invite per recipient (refreshing a
 *         pending address) and email each. Rate limited per org.
 *       - expired grant (valid signature): mint nothing; mail a sign-in link to
 *         the org's registered owner address. Returns `recovered: true`.
 *       - invalid grant: GRANT_INVALID.
 *
 * Mint logic is in `services/invites/mint.ts`, shared with `POST /v1/user/create`.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { getOrganisationStore } from '../services/organisation-store/index.js';
import { getRegistrationInvitesStore } from '../services/registration-invites-store/index.js';
import { mintInviteBatch } from '../services/invites/mint.js';
import { verifyGrantToken } from '../services/grant-token.js';
import { ownerSignInUrl } from '../services/decisions/org.js';
import { checkInviteIpRate } from '../services/invite-mint-rate.js';
import { getMailer } from '@aggregator-dpg/mailer';
import { renderOwnerGrantRefreshed } from '../services/email-templates/index.js';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';

const RecipientSchema = z.object({
  email: z.string().min(3),
  name: z.string().optional(),
});

const MintBodySchema = z.object({
  grant: z.string().min(1),
  // Per-request recipient cap (INVITE_MINT_MAX_RECIPIENTS).
  recipients: z.array(RecipientSchema).min(1).max(config.INVITE_MINT_MAX_RECIPIENTS),
});

const MintResponseSchema = z.object({
  /** True when the grant was expired and a sign-in link was mailed (nothing minted). */
  recovered: z.boolean(),
  sent: z.number().int(),
  resent: z.number().int(),
  invalid: z.array(z.object({ email: z.string(), reason: z.string() })),
  /** Addresses already coordinators of this org (nothing mailed). */
  existing: z.array(z.object({ email: z.string(), status: z.string() })),
});

/**
 * Registers the invite mint route.
 *
 * @param app - Fastify instance to attach the route to.
 */
export async function registerInviteRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/admin/v1/invites',
    {
      config: { rbac: { access: 'link_token' } },
      schema: {
        tags: ['invites'],
        summary: 'Mint coordinator invites (owner grant-authed)',
        description:
          'Authed by the owner grant token. A valid grant mints/refreshes one 14-day invite per recipient and emails each. An expired grant mints nothing and re-mails a fresh grant to the registered owner (recovery). Per-IP rate limited.',
        body: MintBodySchema,
        response: { 200: MintResponseSchema, ...errorResponses(400, 409, 429, 503) },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const log = req.log.child({ operation: 'invites.mint' });
      const body = req.body as z.infer<typeof MintBodySchema>;

      // Per-IP throttle, fail-open.
      const ipRl = await checkInviteIpRate(req.ip);
      if (!ipRl.allowed) {
        void reply.header('Retry-After', String(ipRl.retryAfterSeconds));
        throw httpError('RATE_LIMITED', {
          detail: `Retry in ${ipRl.retryAfterSeconds}s.`,
          fields: { retry_after_seconds: ipRl.retryAfterSeconds },
        });
      }

      // Accept an expired-but-signature-valid grant so recovery can run here; a
      // bad signature / wrong audience still fails as GRANT_INVALID.
      const grant = await verifyGrantToken(body.grant, { allowExpired: true });
      if (!grant.ok) {
        throw httpError('GRANT_INVALID');
      }
      const orgId = grant.org;

      const orgStore = getOrganisationStore();
      const org = await orgStore.findById(orgId);
      if (!org.ok) {
        throw httpError('DB_UNAVAILABLE', {
          cause: new Error(org.error.message),
          fields: { sub_operation: 'orgStore.findById' },
        });
      }
      // A grant is revoked once the org is no longer active.
      const orgRow = org.value;
      // The Default org takes no invites.
      if (orgRow?.status !== 'active' || orgRow.isDefault) {
        throw httpError('TARGET_ORG_INACTIVE');
      }

      // Expired grant: mail a sign-in link to the registered owner address,
      // never a request input. No new grant is minted.
      if (grant.expired) {
        const mail = renderOwnerGrantRefreshed({
          orgName: orgRow.displayName,
          inviteUrl: ownerSignInUrl(),
        });
        const send = await getMailer().send({
          to: orgRow.ownerEmail,
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
        });
        if (!send.ok) {
          log.warn(
            {
              status: 'failure',
              sub_operation: 'mailer.send.grantRecovery',
              code: send.error.code,
            },
            'sign-in email delivery failed',
          );
        }
        log.info(
          { status: 'success', org_id: orgId, recovered: true },
          'expired grant — sign-in link mailed',
        );
        return reply
          .status(200)
          .send({ recovered: true, sent: 0, resent: 0, invalid: [], existing: [] });
      }

      const summary = await mintInviteBatch({
        invites: getRegistrationInvitesStore(),
        mailer: getMailer(),
        orgId,
        orgName: orgRow.displayName,
        inviterEmail: orgRow.ownerEmail,
        recipients: body.recipients,
        ttlSec: config.INVITE_TOKEN_TTL_SECONDS,
        createdBy: `grant:${orgId}`,
        log,
      });
      log.info(
        {
          status: 'success',
          org_id: orgId,
          sent: summary.sent,
          resent: summary.resent,
          invalid: summary.invalid.length,
          existing: summary.existing.length,
        },
        'invites minted',
      );
      return reply.status(200).send({ recovered: false, ...summary });
    },
  );
}
