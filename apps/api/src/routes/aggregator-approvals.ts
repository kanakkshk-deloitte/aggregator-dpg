/**
 * Coordinator approval routes reached from the emailed review link (api app).
 *
 *   GET  /admin/v1/aggregator-registrations/read/:id?token=...&intent=approve|reject
 *     Renders the confirm page, or an "already decided" page when the
 *     coordinator is no longer pending.
 *
 *   POST /admin/v1/aggregator-registrations/decision/:id
 *     Body: { token, decision: 'approve' | 'reject', reason? }
 *     Verifies the token and records the decision through `decideCoordinator`.
 *
 *   POST /admin/v1/aggregator-registrations/renew/:id
 *     Mints a fresh token from an expired one and renders the confirm page.
 *
 * The coordinator's `status` column is the source of truth. Keycloak mirrors
 * it in the `decision_made` attribute so login can be gated from the token.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { ERR } from '../errors/codes.js';
import { formatApprovalTtl } from '../services/approval-token.js';
import { getUserStore } from '../services/user-store/index.js';
import { getIdpAdmin } from '../services/idp-admin/index.js';
import { renderConfirmPage, renderResultPage } from '../views/approval-pages.js';
import { mintReviewToken } from '../services/registration-notify.js';
import { sendHtml, sendPage, missingTokenPage, verifyTokenForId } from './approval-shared.js';
import { checkApprovalVerifyRate } from '../services/approval-verify-rate.js';
import { decideCoordinator, LINK_DECIDER } from '../services/decisions/coordinator.js';
import type { Coordinator } from '../services/user-store/index.js';
import { KC_ATTR } from '../services/idp-admin/index.js';
import { recordLoginIdentity } from '../services/identity-store/record.js';
import type { IdpUser } from '../services/idp-admin/index.js';

const DecisionBodySchema = z.object({
  token: z.string().min(1),
  decision: z.enum(['approve', 'reject']),
  reason: z.string().max(2000).optional(),
});

const ApprovalParamsSchema = z.object({
  id: z.string(),
});

const ReadQuerySchema = z.object({
  token: z.string().optional(),
  intent: z.string().optional(),
});

/**
 * Per-IP throttle for the read, decision and renew routes, against token brute-forcing.
 *
 * Renders an HTML 429 page when the caller is limited.
 *
 * @param req - The inbound request (its `ip` is the bucket key).
 * @param reply - The reply to render the 429 page onto when limited.
 * @returns True if the request was rate-limited (caller must stop).
 */
async function approvalVerifyRateLimited(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  const ip = (req.ip ?? '0.0.0.0').toString();
  const rate = await checkApprovalVerifyRate(ip);
  if (!rate.allowed) {
    void reply.header('Retry-After', String(rate.retryAfterSeconds));
    req.log.warn({
      operation: 'aggregator-approval.verify',
      status: 'rate_limited',
      retry_after_seconds: rate.retryAfterSeconds,
    });
    sendHtml(
      reply,
      429,
      renderResultPage({
        status: 'error',
        title: 'Too many attempts',
        message: 'Too many attempts from this location. Please wait and try again.',
      }),
    );
    return true;
  }
  return false;
}

/**
 * Emits a structured audit log entry for an admin approval action.
 *
 * The link carries no signed-in admin identity, so every entry logs `identity_verified: false`.
 *
 * @param req - The Fastify request handling the admin action.
 * @param fields - Aggregator id, action and optional decision.
 */
function logApprovalAudit(
  req: FastifyRequest,
  fields: {
    aggregatorId: string;
    action: 'view_confirm' | 'decision' | 'renew';
    decision?: 'approve' | 'reject';
  },
): void {
  req.log.info(
    {
      operation: 'aggregator-approval.audit',
      status: 'success',
      aggregator_id: fields.aggregatorId,
      action: fields.action,
      decision: fields.decision ?? null,
      identity_verified: false,
      client_ip: req.ip,
      request_id: req.id,
    },
    'admin approval action',
  );
}

export async function registerAggregatorApprovalRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/admin/v1/aggregator-registrations/read/:id',
    {
      config: { rbac: { access: 'link_token' } },
      schema: {
        tags: ['aggregator-approvals'],
        summary: 'Render the admin approve/reject page',
        description:
          'HTML page reached from the admin notification email. Verifies the signed token and renders the approval form for the given aggregator registration id. All responses (200, 400 invalid/missing token, 404 unknown aggregator, 503 backing service down) are text/html pages, so no JSON response schema is declared.',
        params: ApprovalParamsSchema,
        querystring: ReadQuerySchema,
      },
    },
    async (
      req: FastifyRequest<{
        Params: { id: string };
        Querystring: { token?: string; intent?: string };
      }>,
      reply: FastifyReply,
    ) => {
      if (await approvalVerifyRateLimited(req, reply)) return;

      const aggregatorId = req.params.id;
      const { token } = req.query;

      if (!token) return sendPage(reply, missingTokenPage());

      // An expired but valid link offers "Regenerate & review"; an invalid one errors.
      const verified = await verifyTokenForId(token, aggregatorId, 'aggregator');
      if (!verified.ok) {
        const lenient = await verifyTokenForId(token, aggregatorId, 'aggregator', {
          allowExpired: true,
        });
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
                url: `${config.PUBLIC_API_URL}/admin/v1/aggregator-registrations/renew/${aggregatorId}`,
                token,
                label: 'Regenerate & review',
              },
            }),
          );
        }
        return sendPage(reply, verified.page);
      }

      const lookup = await loadAggregatorAndUser(aggregatorId);
      if (!lookup.ok) return sendHtml(reply, lookup.status, lookup.html);

      const prior = decisionFromStatus(lookup.aggregator.status);
      if (prior) {
        return sendHtml(reply, 200, renderResultPage(alreadyDecidedView(prior)));
      }

      // The link must be bound to the coordinator's org.
      if (lookup.aggregator.parentOrgId && verified.org !== lookup.aggregator.parentOrgId) {
        return sendHtml(reply, 400, renderResultPage(orgMismatchView()));
      }
      const pageToken = token;

      logApprovalAudit(req, { aggregatorId, action: 'view_confirm' });

      return sendHtml(
        reply,
        200,
        renderConfirmPage({
          aggregatorId,
          token: pageToken,
          applicantEmail: lookup.kcUser.email,
          ...(lookup.aggregator.inviteEmail ? { invitedEmail: lookup.aggregator.inviteEmail } : {}),
          association: lookup.aggregator.name,
          // `type` is null when the coordinator serves every domain; show `actor_type` then.
          aggregatorType: lookup.aggregator.type ?? lookup.aggregator.actorType,
          postUrl: `${config.PUBLIC_API_URL}/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
          expiresInText: formatApprovalTtl(config.APPROVAL_TOKEN_TTL_SECONDS),
        }),
      );
    },
  );

  app.post(
    '/admin/v1/aggregator-registrations/decision/:id',
    {
      config: { rbac: { access: 'link_token' } },
      schema: {
        tags: ['aggregator-approvals'],
        summary: 'Approve or reject a pending aggregator',
        description:
          'Records the admin decision (approve/reject) for the registration id. On approve, enables the disabled Keycloak user and confirms the signalstack push. This is a browser form flow: every response (200 result page, 400 invalid token/body, 404 unknown aggregator, 503 backing service down) is a text/html page, so neither a body schema nor JSON response schemas are declared — the handler validates the form body itself (token, decision approve|reject, optional reason) and renders an HTML error page on failure. Body shape: { token: string, decision: "approve" | "reject", reason?: string }.',
        params: ApprovalParamsSchema,
      },
    },
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (await approvalVerifyRateLimited(req, reply)) return;

      const aggregatorId = req.params.id;
      const parsed = DecisionBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return sendHtml(
          reply,
          400,
          renderResultPage({
            status: 'error',
            title: 'Bad request',
            message: 'Invalid form submission.',
          }),
        );
      }

      const verified = await verifyTokenForId(parsed.data.token, aggregatorId, 'aggregator');
      if (!verified.ok) return sendPage(reply, verified.page);

      const lookup = await loadAggregatorAndUser(aggregatorId);
      if (!lookup.ok) return sendHtml(reply, lookup.status, lookup.html);

      // Anything other than `pending` is already decided.
      const prior = decisionFromStatus(lookup.aggregator.status);
      if (prior) {
        return sendHtml(reply, 200, renderResultPage(alreadyDecidedView(prior)));
      }

      // The token's `org` claim must match, so an owner's link decides only its own org's coordinators.
      const parentOrgId = lookup.aggregator.parentOrgId;
      if (parentOrgId && verified.org !== parentOrgId) {
        return sendHtml(reply, 400, renderResultPage(orgMismatchView()));
      }

      logApprovalAudit(req, { aggregatorId, action: 'decision', decision: parsed.data.decision });

      const outcome = await decideCoordinator({
        aggregatorId,
        decision: parsed.data.decision,
        ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
        decidedBy: LINK_DECIDER,
        requestId: req.id,
        log: req.log,
      });
      const email = lookup.aggregator.contact.email;
      switch (outcome.kind) {
        case 'decided':
          return sendHtml(
            reply,
            200,
            renderResultPage(
              outcome.decision === 'approve'
                ? {
                    status: 'success',
                    title: 'Application approved',
                    message: `${email} can now sign in to the portal.`,
                  }
                : {
                    status: 'success',
                    title: 'Application rejected',
                    message: `${email} has been notified.`,
                  },
            ),
          );
        case 'already_decided': {
          const prior = decisionFromStatus(outcome.status);
          return sendHtml(
            reply,
            200,
            renderResultPage(alreadyDecidedView(prior ?? { decision: 'approved' })),
          );
        }
        case 'not_found':
          return sendHtml(
            reply,
            404,
            renderResultPage({
              status: 'error',
              title: 'Not found',
              message: 'Aggregator not found.',
            }),
          );
        case 'org_inactive':
          return sendHtml(
            reply,
            200,
            renderResultPage({
              status: 'error',
              title: ERR.TARGET_ORG_INACTIVE.title,
              message: ERR.TARGET_ORG_INACTIVE.detail,
            }),
          );
        case 'unavailable': {
          let message = 'Database unavailable. Please try again shortly.';
          if (outcome.dependency === 'signalstack') {
            message =
              'Could not register the aggregator with the signalstack network. The application is still pending — open this approval link again once the signalstack service is reachable.';
          } else if (outcome.dependency === 'idp') {
            message = 'Identity service unavailable. Please try again shortly.';
          }
          return sendHtml(
            reply,
            503,
            renderResultPage({
              status: 'error',
              title: 'Action failed',
              message,
            }),
          );
        }
      }
    },
  );

  app.post(
    '/admin/v1/aggregator-registrations/renew/:id',
    {
      config: { rbac: { access: 'link_token' } },
      schema: {
        tags: ['aggregator-approvals'],
        summary: 'Regenerate an expired approval link and show the confirm page',
        description:
          'Reached from the "Regenerate & review" button on the expired-link page. Accepts an expired-but-signature-valid token as proof the reviewer held a legitimate link, mints a fresh decision token (preserving the org binding), and renders the approve/reject confirm page inline — no email.',
        params: ApprovalParamsSchema,
      },
    },
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (await approvalVerifyRateLimited(req, reply)) return;

      const aggregatorId = req.params.id;
      const body = (req.body ?? {}) as { token?: string };
      const token = typeof body.token === 'string' ? body.token : '';

      const verified = await verifyTokenForId(token, aggregatorId, 'aggregator', {
        allowExpired: true,
      });
      if (!verified.ok) return sendPage(reply, verified.page);

      const lookup = await loadAggregatorAndUser(aggregatorId);
      if (!lookup.ok) return sendHtml(reply, lookup.status, lookup.html);

      const prior = decisionFromStatus(lookup.aggregator.status);
      if (prior) {
        return sendHtml(reply, 200, renderResultPage(alreadyDecidedView(prior)));
      }

      // Only a link bound to the coordinator's current org may be renewed.
      const currentOrg = lookup.aggregator.parentOrgId;
      if (currentOrg && verified.org !== currentOrg) {
        return sendHtml(reply, 400, renderResultPage(orgMismatchView()));
      }

      logApprovalAudit(req, { aggregatorId, action: 'renew' });

      const freshToken = await mintReviewToken(aggregatorId, currentOrg ?? verified.org);
      return sendHtml(
        reply,
        200,
        renderConfirmPage({
          aggregatorId,
          token: freshToken,
          applicantEmail: lookup.kcUser.email,
          ...(lookup.aggregator.inviteEmail ? { invitedEmail: lookup.aggregator.inviteEmail } : {}),
          association: lookup.aggregator.name,
          aggregatorType: lookup.aggregator.type ?? lookup.aggregator.actorType,
          postUrl: `${config.PUBLIC_API_URL}/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
          expiresInText: formatApprovalTtl(config.APPROVAL_TOKEN_TTL_SECONDS),
        }),
      );
    },
  );
}

/** The result page for a link bound to a different org than the coordinator's. */
function orgMismatchView(): Parameters<typeof renderResultPage>[0] {
  return {
    status: 'error',
    title: 'Invalid link',
    message: 'Token does not match this organisation.',
  };
}

interface PriorDecision {
  decision: 'approved' | 'rejected';
}

/**
 * Maps a coordinator's status to its prior decision, or `null` while pending.
 *
 * `retired` counts as approved, so a retired account is never reactivated.
 */
function decisionFromStatus(status: Coordinator['status']): PriorDecision | null {
  switch (status) {
    case 'active':
    case 'retired':
      return { decision: 'approved' };
    case 'inactive':
      return { decision: 'rejected' };
    case 'pending':
    default:
      return null;
  }
}

function alreadyDecidedView(prior: PriorDecision): {
  status: 'info';
  title: string;
  message: string;
} {
  if (prior.decision === 'approved') {
    return {
      status: 'info',
      title: 'Already approved',
      message: 'This application has already been approved. No further action is required.',
    };
  }
  return {
    status: 'info',
    title: 'Already rejected',
    message: 'This application has already been rejected. No further action is required.',
  };
}

type LookupOk = { ok: true; aggregator: Coordinator; kcUser: IdpUser };
type LookupErr = { ok: false; status: number; html: string };

async function loadAggregatorAndUser(aggregatorId: string): Promise<LookupOk | LookupErr> {
  const store = getUserStore();
  const idp = getIdpAdmin();

  const stored = await store.findById(aggregatorId);
  if (!stored.ok) {
    return {
      ok: false,
      status: 503,
      html: renderResultPage({
        status: 'error',
        title: 'Service unavailable',
        message: 'Could not load aggregator record.',
      }),
    };
  }
  if (!stored.value) {
    return {
      ok: false,
      status: 404,
      html: renderResultPage({
        status: 'error',
        title: 'Not found',
        message: 'Aggregator not found.',
      }),
    };
  }

  const kc = await idp.findByAttribute(KC_ATTR.AGGREGATOR_ID, aggregatorId);
  if (!kc.ok) {
    return {
      ok: false,
      status: 503,
      html: renderResultPage({
        status: 'error',
        title: 'Identity service unavailable',
        message: 'Could not load identity record.',
      }),
    };
  }
  if (!kc.value) {
    return {
      ok: false,
      status: 404,
      html: renderResultPage({
        status: 'error',
        title: 'Not found',
        message: 'Identity record missing.',
      }),
    };
  }
  // Record the coordinator's IdP login. Best effort; never blocks the review.
  await recordLoginIdentity(aggregatorId, kc.value.id, 'aggregator-approvals.recordIdentity');
  return { ok: true, aggregator: stored.value, kcUser: kc.value };
}
