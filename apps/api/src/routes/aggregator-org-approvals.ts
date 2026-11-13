/**
 * Org approval endpoints reached from the review email, sent to the parent
 * org's owner (the network admins for a top-level org).
 *
 *   GET  /admin/v1/orgs/read/:id?token=...&intent=approve|reject
 *     HTML confirmation page.
 *
 *   POST /admin/v1/orgs/decision/:id   body { token, decision }
 *     Approves or rejects a pending org (see `decideOrg`).
 *
 *   POST /admin/v1/orgs/renew/:id   body { token }
 *     Mints a fresh review token for an expired link and shows the confirm page.
 *
 * The signed link is the authority: whoever holds a valid token decides. It is
 * not checked against the console's `orgs.onboard`.
 * Belongs to `@aggregator-dpg/api`.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DecisionReasonSchema } from '@aggregator-dpg/shared-primitives/user-org';
import { config } from '../config.js';
import { getOrganisationStore } from '../services/organisation-store/index.js';
import type { Organisation } from '../services/organisation-store/index.js';
import { formatApprovalTtl } from '../services/approval-token.js';
import { renderConfirmPage, renderResultPage } from '../views/approval-pages.js';
import { mintReviewToken } from '../services/registration-notify.js';
import { decideOrg } from '../services/decisions/org.js';
import { LINK_DECIDER } from '../services/decisions/coordinator.js';
import {
  sendHtml,
  sendPage,
  missingTokenPage,
  notFoundPage,
  serviceUnavailablePage,
  verifyTokenForId,
  type HtmlPage,
} from './approval-shared.js';

/** The longest reason, from the shared decision schema, so the console and the emailed form agree. */
const ORG_REASON_MAX = DecisionReasonSchema.maxLength;

const OrgDecisionBodySchema = z
  .object({
    token: z.string().min(1),
    decision: z.enum(['approve', 'reject']),
    /** Surfaced to the applicant. */
    reason: DecisionReasonSchema.optional(),
  })
  .refine((b) => b.decision !== 'reject' || (b.reason ?? '').length > 0, {
    message: 'reason required',
    path: ['reason'],
  });

/**
 * The error page text for a bad decision form.
 *
 * @param reasonIssue - The Zod issue code on `reason`, if any.
 * @returns The message for the applicant's reviewer.
 */
function reasonMessage(reasonIssue: string | undefined): string {
  if (reasonIssue === 'too_big') {
    return `The reason can be at most ${ORG_REASON_MAX} characters. Go back and shorten it.`;
  }
  if (reasonIssue) return 'Give a reason when rejecting an organisation. Go back and try again.';
  return 'Invalid form submission.';
}

const OrgApprovalParamsSchema = z.object({ id: z.string() });

const OrgReadQuerySchema = z.object({
  token: z.string().optional(),
  intent: z.string().optional(),
});

const ORG_NOUN = 'organisation';
const orgNotFoundPage = (): HtmlPage => notFoundPage('Not found', 'Organisation not found.');
const orgUnavailablePage = (): HtmlPage =>
  serviceUnavailablePage('Service unavailable', 'Could not load the organisation record.');

/**
 * Registers the org approval routes.
 *
 * @param app - Fastify instance to attach the routes to.
 */
export async function registerAggregatorOrgApprovalRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/admin/v1/orgs/read/:id',
    {
      config: { rbac: { access: 'link_token' } },
      schema: {
        tags: ['aggregator-orgs'],
        summary: 'Render the network-admin approve/reject page for an org',
        description:
          'HTML page reached from the network-admin notification email. All responses are text/html.',
        params: OrgApprovalParamsSchema,
        querystring: OrgReadQuerySchema,
      },
    },
    async (
      req: FastifyRequest<{
        Params: { id: string };
        Querystring: { token?: string; intent?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const orgId = req.params.id;
      const { token } = req.query;

      if (!token) return sendPage(reply, missingTokenPage());

      const verified = await verifyTokenForId(token, orgId, ORG_NOUN);
      if (!verified.ok) {
        // An expired but otherwise valid link offers a one-click regenerate.
        // Any other failure shows the error page.
        const lenient = await verifyTokenForId(token, orgId, ORG_NOUN, { allowExpired: true });
        if (lenient.ok) {
          return sendHtml(
            reply,
            400,
            renderResultPage({
              status: 'error',
              title: 'Link expired',
              message:
                'This approval link has expired. Click below to regenerate a fresh link and continue to the review.',
              action: {
                url: `${config.PUBLIC_API_URL}/admin/v1/orgs/renew/${orgId}`,
                token,
                label: 'Regenerate & review',
              },
            }),
          );
        }
        return sendPage(reply, verified.page);
      }

      const lookup = await getOrganisationStore().findById(orgId);
      if (!lookup.ok) return sendPage(reply, orgUnavailablePage());
      if (!lookup.value) return sendPage(reply, orgNotFoundPage());

      const prior = orgDecidedView(lookup.value.status);
      if (prior) return sendHtml(reply, 200, renderResultPage(prior));

      return sendHtml(
        reply,
        200,
        renderConfirmPage({
          reasonRequired: true,
          ...(ORG_REASON_MAX === null ? {} : { reasonMaxLength: ORG_REASON_MAX }),
          aggregatorId: orgId,
          token,
          applicantEmail: lookup.value.ownerEmail,
          association: lookup.value.displayName,
          aggregatorType: 'organisation',
          entityLabel: 'organisation',
          postUrl: `${config.PUBLIC_API_URL}/admin/v1/orgs/decision/${orgId}`,
          expiresInText: formatApprovalTtl(config.APPROVAL_TOKEN_TTL_SECONDS),
        }),
      );
    },
  );

  app.post(
    '/admin/v1/orgs/decision/:id',
    {
      config: { rbac: { access: 'link_token' } },
      schema: {
        tags: ['aggregator-orgs'],
        summary: 'Approve or reject a pending org',
        description:
          'Browser form flow; every response is text/html. Both decisions are an atomic status CAS from pending first; approve then enables the owner (Keycloak user, org_owner role, group) and mails a sign-in link; reject mails the owner.',
        params: OrgApprovalParamsSchema,
      },
    },
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const orgId = req.params.id;

      const parsed = OrgDecisionBodySchema.safeParse(req.body);
      if (!parsed.success) {
        const reasonIssue = parsed.error.issues.find((i) => i.path[0] === 'reason');
        return sendHtml(
          reply,
          400,
          renderResultPage({
            status: 'error',
            title: 'Bad request',
            message: reasonMessage(reasonIssue?.code),
          }),
        );
      }

      const verified = await verifyTokenForId(parsed.data.token, orgId, ORG_NOUN);
      if (!verified.ok) return sendPage(reply, verified.page);

      const outcome = await decideOrg({
        orgId,
        decision: parsed.data.decision,
        ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
        decidedBy: LINK_DECIDER,
        log: req.log,
      });
      switch (outcome.kind) {
        case 'decided':
          return sendHtml(
            reply,
            200,
            renderResultPage(
              outcome.decision === 'approve'
                ? {
                    status: 'success',
                    title: 'Organisation approved',
                    message:
                      'The organisation is now live. Its owner can sign in, and coordinators can register under it.',
                  }
                : {
                    status: 'success',
                    title: 'Organisation rejected',
                    message: outcome.notified
                      ? 'The owner has been notified.'
                      : 'The organisation was rejected, but the notification email could not be delivered.',
                  },
            ),
          );
        case 'already_decided': {
          const prior = orgDecidedView(outcome.status);
          return sendHtml(
            reply,
            200,
            renderResultPage((prior ?? orgDecidedView('active')) as ResultView),
          );
        }
        case 'not_found':
          return sendPage(reply, orgNotFoundPage());
        case 'unavailable':
          return sendPage(
            reply,
            serviceUnavailablePage(
              'Action failed',
              'Database unavailable. Please try again shortly.',
            ),
          );
      }
    },
  );

  app.post(
    '/admin/v1/orgs/renew/:id',
    {
      config: { rbac: { access: 'link_token' } },
      schema: {
        tags: ['aggregator-orgs'],
        summary: 'Regenerate an expired org review link and show the confirm page',
        description:
          'Reached from the "Regenerate & review" button on the expired-link page. Accepts an expired-but-signature-valid token as proof the admin held a legitimate link, mints a fresh decision token, and renders the approve/reject confirm page inline (no email).',
        params: OrgApprovalParamsSchema,
      },
    },
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const orgId = req.params.id;
      const body = (req.body ?? {}) as { token?: string };

      const verified = await verifyTokenForId(body.token ?? '', orgId, ORG_NOUN, {
        allowExpired: true,
      });
      if (!verified.ok) return sendPage(reply, verified.page);

      const lookup = await getOrganisationStore().findById(orgId);
      if (!lookup.ok) return sendPage(reply, orgUnavailablePage());
      if (!lookup.value) return sendPage(reply, orgNotFoundPage());

      const prior = orgDecidedView(lookup.value.status);
      if (prior) return sendHtml(reply, 200, renderResultPage(prior));

      const freshToken = await mintReviewToken(orgId);
      return sendHtml(
        reply,
        200,
        renderConfirmPage({
          reasonRequired: true,
          ...(ORG_REASON_MAX === null ? {} : { reasonMaxLength: ORG_REASON_MAX }),
          aggregatorId: orgId,
          token: freshToken,
          applicantEmail: lookup.value.ownerEmail,
          association: lookup.value.displayName,
          aggregatorType: 'organisation',
          entityLabel: 'organisation',
          postUrl: `${config.PUBLIC_API_URL}/admin/v1/orgs/decision/${orgId}`,
          expiresInText: formatApprovalTtl(config.APPROVAL_TOKEN_TTL_SECONDS),
        }),
      );
    },
  );
}

type ResultView = { status: 'success' | 'error' | 'info'; title: string; message: string };

/**
 * Maps an org status to an already-decided result view, or `null` when the
 * org is still `pending` and the decision should proceed.
 *
 * @param status - The org's lifecycle status.
 * @returns A result-page view for terminal states, else `null`.
 */
function orgDecidedView(status: Organisation['status']): ResultView | null {
  if (status === 'pending') return null;
  if (status === 'active' || status === 'retired') {
    return {
      status: 'info',
      title: 'Already approved',
      message: 'This organisation has already been approved. No further action is required.',
    };
  }
  return {
    status: 'info',
    title: 'Already rejected',
    message: 'This organisation has already been rejected. No further action is required.',
  };
}
