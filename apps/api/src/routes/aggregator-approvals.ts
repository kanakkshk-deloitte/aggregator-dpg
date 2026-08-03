/**
 * Admin approval endpoints.
 *
 * URL shape mirrors the spec under `4.3.2 Endpoints by Actor & Action`:
 *
 *   GET  /admin/v1/aggregator-registrations/read/:id?token=...&intent=approve|reject
 *     Renders an HTML confirmation page that tells the admin which action
 *     they're about to take. If `aggregators.status` is already terminal
 *     (`active` after approve / `inactive` after reject) — i.e. a previous
 *     click ran to completion — it instead renders an "already decided"
 *     page so duplicate clicks never resend emails.
 *
 *   POST /admin/v1/aggregator-registrations/decision/:id
 *     Body: { token, decision: 'approve' | 'reject', reason? }
 *     Verifies the JWT, re-checks `aggregators.status` (single-use guard),
 *     applies the action:
 *       approve → store.updateStatus(id, 'active') + idp.enableUser
 *                 + idp.setUserDecision(kcId, 'approved')
 *       reject  → store.updateStatus(id, 'inactive')
 *                 + idp.setUserDecision(kcId, 'rejected')
 *     Sends the applicant a notification email and returns a result page.
 *
 * Source of truth for the decision is the DB column `aggregators.status`.
 * Keycloak mirrors the decision via the `decision_made` user attribute so
 * the auth middleware can gate login at JWT-verify time without an extra
 * DB hit.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config, orgHierarchyEnabled } from '../config.js';
import { getAggregatorOrgStore } from '../services/aggregator-org-store/index.js';
import { ERR } from '../errors/codes.js';
import { formatApprovalTtl } from '../services/approval-token.js';
import { getAggregatorStore } from '../services/aggregator-store/index.js';
import { getIdpAdmin } from '../services/idp-admin/index.js';
import { getMailer } from '../services/mailer/index.js';
import { getSignalStackWriter } from '../services/signalstack.js';
import { getNetworkConfig } from '../services/network-config.js';
import {
  renderApplicantApproved,
  renderApplicantRejected,
} from '../services/email-templates/index.js';
import { renderConfirmPage, renderResultPage } from '../views/approval-pages.js';
import { mintApprovalTokenPair } from '../services/registration-notify.js';
import { sendHtml, sendPage, missingTokenPage, verifyTokenForId } from './approval-shared.js';
import type { Aggregator } from '../services/aggregator-store/index.js';
import { KC_ATTR } from '../services/idp-admin/index.js';
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

export async function registerAggregatorApprovalRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/admin/v1/aggregator-registrations/read/:id',
    {
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
      const aggregatorId = req.params.id;
      const { token, intent } = req.query;

      if (!token) return sendPage(reply, missingTokenPage());

      // Strict verify first (rejects expired). A merely-expired link offers an
      // inline "Regenerate & review" step (no self-email to the reviewer);
      // invalid/malformed still error.
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
      const effectiveIntent = isIntent(intent) ? intent : verified.intent;

      const lookup = await loadAggregatorAndUser(aggregatorId);
      if (!lookup.ok) return sendHtml(reply, lookup.status, lookup.html);

      const prior = decisionFromStatus(lookup.aggregator.status);
      if (prior) {
        return sendHtml(reply, 200, renderResultPage(alreadyDecidedView(prior)));
      }

      return sendHtml(
        reply,
        200,
        renderConfirmPage({
          aggregatorId,
          intent: effectiveIntent,
          token,
          applicantEmail: lookup.kcUser.email,
          association: lookup.aggregator.name,
          // For aggregator actors `type` is null. Surface `actor_type`
          // instead so the admin page always shows something meaningful.
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
      schema: {
        tags: ['aggregator-approvals'],
        summary: 'Approve or reject a pending aggregator',
        description:
          'Records the admin decision (approve/reject) for the registration id. On approve, enables the disabled Keycloak user and confirms the signalstack push. This is a browser form flow: every response (200 result page, 400 invalid token/body, 404 unknown aggregator, 503 backing service down) is a text/html page, so neither a body schema nor JSON response schemas are declared — the handler validates the form body itself (token, decision approve|reject, optional reason) and renders an HTML error page on failure. Body shape: { token: string, decision: "approve" | "reject", reason?: string }.',
        params: ApprovalParamsSchema,
      },
    },
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const aggregatorId = req.params.id;
      const log = req.log.child({
        operation: 'aggregator-approval.decide',
        aggregator_id: aggregatorId,
      });
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

      // Single-use guard: DB status is the source of truth. Anything other
      // than `pending` means this aggregator has already been decided.
      const prior = decisionFromStatus(lookup.aggregator.status);
      if (prior) {
        return sendHtml(reply, 200, renderResultPage(alreadyDecidedView(prior)));
      }

      // Org-bound coordinator: the token must carry the matching `org` claim so
      // an owner's link can only decide their own org's coordinators (spec §9 /
      // A1). Enforced whenever the record has a parent_org_id — it is a security
      // invariant on the record, independent of the runtime flag.
      const parentOrgId = lookup.aggregator.parentOrgId;
      if (parentOrgId && verified.org !== parentOrgId) {
        return sendHtml(
          reply,
          400,
          renderResultPage({
            status: 'error',
            title: 'Invalid link',
            message: 'Token does not match this organisation.',
          }),
        );
      }

      // Re-validate the target org is still active before provisioning (spec
      // §6.2): a row can be rejected/retired between submit and approval. Only
      // when the hierarchy is enabled and the coordinator is org-bound.
      if (orgHierarchyEnabled() && parentOrgId) {
        const org = await getAggregatorOrgStore().findById(parentOrgId);
        if (!org.ok || !org.value || org.value.status !== 'active') {
          return sendHtml(
            reply,
            200,
            renderResultPage({
              status: 'error',
              title: ERR.TARGET_ORG_INACTIVE.title,
              message: ERR.TARGET_ORG_INACTIVE.detail,
            }),
          );
        }
      }

      const store = getAggregatorStore();
      const idp = getIdpAdmin();
      const mailer = getMailer();

      if (parsed.data.decision === 'approve') {
        // 1. Signalstack first — approval is a hard-gated registration step.
        //    Until the upsert succeeds we leave `aggregators.status` at
        //    `pending` and the KC user disabled, so the applicant cannot log
        //    in. Re-clicking the approval link retries cleanly because the
        //    single-use guard at line ~178 reads DB status (still pending)
        //    and the upsert is idempotent on `external_id` (aggregatorId).
        //
        //    When signalstack is unconfigured (getSignalStackWriter() returns
        //    null), we skip this step — local/dev stacks without a
        //    signalstack peer continue to function.
        const signalstack = getSignalStackWriter();
        let signalstackOrgId: string | null = null;
        if (signalstack) {
          const upsertStart = Date.now();
          // Signalstack's dashboard endpoint fails with NO_DOMAINS_CONFIGURED
          // when the org's metadata.domains is empty, so always send a
          // non-empty list. Use the aggregator's chosen participant focus
          // (`aggregators.type`) when it matches a domain declared by the
          // active network; otherwise fall back to the FULL domain list
          // from the live network config (so orange_dot legacy rows pick
          // up `['tourist','practitioner']` instead of a stale
          // `['seeker','provider']`).
          const networkCfg = await getNetworkConfig();
          const t = lookup.aggregator.type;
          const aggregatorDomains: string[] =
            t && networkCfg.domainIds.includes(t) ? [t] : networkCfg.domainIds;
          const upsertResult = await signalstack.upsertAggregator({
            external_id: aggregatorId,
            name: lookup.aggregator.name,
            slug: lookup.aggregator.orgSlug,
            domains: aggregatorDomains,
            requestId: req.id,
          });
          if (!upsertResult.success) {
            log.error(
              {
                status: 'failure',
                sub_operation: 'signalstack.upsertAggregator',
                code: upsertResult.error.code,
                cause: upsertResult.error.message,
                latency_ms: Date.now() - upsertStart,
              },
              'signalstack aggregator upsert failed — approval aborted, admin can retry',
            );
            return sendHtml(
              reply,
              503,
              renderResultPage({
                status: 'error',
                title: 'Action failed',
                message:
                  'Could not register the aggregator with the signalstack network. The application is still pending — open this approval link again once the signalstack service is reachable.',
              }),
            );
          }
          signalstackOrgId = upsertResult.value.org_id;
          log.info(
            {
              status: 'success',
              sub_operation: 'signalstack.upsertAggregator',
              signalstack_org_id: signalstackOrgId,
              domains: aggregatorDomains,
              aggregator_type: lookup.aggregator.type,
              latency_ms: Date.now() - upsertStart,
            },
            'aggregator registered in signalstack',
          );
        }

        // 2. KC enableUser — must succeed for the applicant to authenticate.
        //    Idempotent set-state call; safe to retry on next click. Note:
        //    the approval token TTL (DEFAULT_TTL_SEC=1h in
        //    services/approval-token.ts) caps the retry window. If a
        //    signalstack/IDP outage exceeds the TTL, the admin must
        //    request a fresh approval email.
        const enableStart = Date.now();
        const enable = await idp.enableUser(lookup.kcUser.id);
        if (!enable.ok) {
          log.error(
            {
              status: 'failure',
              sub_operation: 'idp.enableUser',
              code: enable.error.code,
              cause: enable.error.message,
              latency_ms: Date.now() - enableStart,
            },
            'failed to enable KC user during approval — admin can retry',
          );
          return sendHtml(
            reply,
            503,
            renderResultPage({
              status: 'error',
              title: 'Action failed',
              message: 'Identity service unavailable. Please try again shortly.',
            }),
          );
        }

        // 3. KC decision stamp — soft-fail. The drift-reconciliation worker
        //    repairs the attribute on its next pass; auth-gate stays open
        //    via the enabled flag set above.
        const stampStart = Date.now();
        const stamp = await idp.setUserDecision(lookup.kcUser.id, 'approved');
        if (!stamp.ok) {
          log.warn(
            {
              status: 'failure',
              sub_operation: 'idp.setUserDecision.approved',
              code: stamp.error.code,
              cause: stamp.error.message,
              latency_ms: Date.now() - stampStart,
            },
            'failed to stamp decision_made=approved on KC user (auth-gate stays open via enabled flag)',
          );
        }

        // 4. Stamp signalstack_org_id on KC attr + DB column. Soft-fail —
        //    the login-time backfill repairs whichever leg lags because the
        //    upstream upsert is idempotent on external_id.
        if (signalstackOrgId) {
          const stampOrgStart = Date.now();
          const [attrWrite, dbWrite] = await Promise.all([
            idp.setAttributes(lookup.kcUser.id, { signalstack_org_id: signalstackOrgId }),
            store.updateSignalstackOrgId(aggregatorId, signalstackOrgId, 'admin'),
          ]);
          if (!attrWrite.ok) {
            log.warn(
              {
                status: 'failure',
                sub_operation: 'idp.setAttributes.signalstack_org_id',
                code: attrWrite.error.code,
                cause: attrWrite.error.message,
                latency_ms: Date.now() - stampOrgStart,
              },
              'failed to stamp signalstack_org_id on KC user — login fallback will retry',
            );
          }
          if (!dbWrite.ok) {
            log.warn(
              {
                status: 'failure',
                sub_operation: 'store.updateSignalstackOrgId',
                code: dbWrite.error.code,
                cause: dbWrite.error.message,
                latency_ms: Date.now() - stampOrgStart,
              },
              'failed to persist signalstack_org_id on aggregators row — login fallback will retry',
            );
          }
        }

        // 5. Atomic compare-and-set pending→active — the single commit point.
        //    A concurrent click (double-submit / prefetch) that already
        //    committed makes this return null, so only the winner runs the
        //    side effects below (notably the applicant email — no duplicate).
        //    Earlier steps are idempotent, so a failure here leaves
        //    status=pending and the admin can re-click to retry.
        const dbUpdateStart = Date.now();
        const dbUpdate = await store.approveFromPending(aggregatorId, 'admin');
        if (!dbUpdate.ok) {
          log.error(
            {
              status: 'failure',
              sub_operation: 'store.approveFromPending',
              code: dbUpdate.error.code,
              cause: dbUpdate.error.message,
              latency_ms: Date.now() - dbUpdateStart,
            },
            'failed to flip aggregator status to active — admin can retry',
          );
          return sendHtml(
            reply,
            503,
            renderResultPage({
              status: 'error',
              title: 'Action failed',
              message: 'Database unavailable. Please try again shortly.',
            }),
          );
        }
        if (dbUpdate.value === null) {
          // A concurrent approval already committed — render already-decided,
          // skip the applicant email so it goes out exactly once.
          return sendHtml(
            reply,
            200,
            renderResultPage(alreadyDecidedView({ decision: 'approved' })),
          );
        }

        const approvedMail = renderApplicantApproved({
          contactName: applicantNameOf(lookup),
          association: lookup.aggregator.name,
          identifier: lookup.aggregator.contact.email,
          signInUrl: `${config.PUBLIC_PORTAL_URL}/login`,
        });
        const sendResult = await mailer.send({
          to: lookup.aggregator.contact.email,
          subject: approvedMail.subject,
          html: approvedMail.html,
          text: approvedMail.text,
        });
        if (!sendResult.ok) {
          log.error(
            {
              status: 'failure',
              sub_operation: 'mailer.send.approved',
              code: sendResult.error.code,
              cause: sendResult.error.message,
            },
            'approved-email delivery failed',
          );
        }
        log.info(
          { status: 'success', decision: 'approve', new_status: 'active' },
          'aggregator approved',
        );
        return sendHtml(
          reply,
          200,
          renderResultPage({
            status: 'success',
            title: 'Application approved',
            message: `${lookup.aggregator.contact.email} can now sign in to the portal.`,
          }),
        );
      }

      // Reject path — DB status → 'inactive', KC user stays disabled.
      // Rejection reason is logged for audit but not persisted (no column
      // yet; revisit when an aggregator_decision_audit table lands).
      const dbUpdate = await store.updateStatus(aggregatorId, 'inactive', 'admin');
      if (!dbUpdate.ok) {
        log.error(
          {
            status: 'failure',
            sub_operation: 'store.updateStatus.inactive',
            code: dbUpdate.error.code,
            cause: dbUpdate.error.message,
          },
          'failed to flip aggregator status to inactive',
        );
        return sendHtml(
          reply,
          503,
          renderResultPage({
            status: 'error',
            title: 'Action failed',
            message: 'Database unavailable. Please try again shortly.',
          }),
        );
      }

      const stamp = await idp.setUserDecision(lookup.kcUser.id, 'rejected');
      if (!stamp.ok) {
        log.warn(
          {
            status: 'failure',
            sub_operation: 'idp.setUserDecision.rejected',
            code: stamp.error.code,
            cause: stamp.error.message,
          },
          'failed to stamp decision_made=rejected on KC user (drift-sync will repair)',
        );
      }

      const rejectedMail = renderApplicantRejected({
        contactName: applicantNameOf(lookup),
        association: lookup.aggregator.name,
        reason: parsed.data.reason,
      });
      const sendResult = await mailer.send({
        to: lookup.aggregator.contact.email,
        subject: rejectedMail.subject,
        html: rejectedMail.html,
        text: rejectedMail.text,
      });
      if (!sendResult.ok) {
        log.error(
          {
            status: 'failure',
            sub_operation: 'mailer.send.rejected',
            code: sendResult.error.code,
            cause: sendResult.error.message,
          },
          'rejected-email delivery failed',
        );
      }
      log.info(
        {
          status: 'success',
          decision: 'reject',
          new_status: 'inactive',
          reason: parsed.data.reason ?? null,
        },
        'aggregator rejected',
      );
      return sendHtml(
        reply,
        200,
        renderResultPage({
          status: 'success',
          title: 'Application rejected',
          message: `${lookup.aggregator.contact.email} has been notified.`,
        }),
      );
    },
  );

  app.post(
    '/admin/v1/aggregator-registrations/renew/:id',
    {
      schema: {
        tags: ['aggregator-approvals'],
        summary: 'Regenerate an expired approval link and show the confirm page',
        description:
          'Reached from the "Regenerate & review" button on the expired-link page. Accepts an expired-but-signature-valid token as proof the reviewer held a legitimate link, mints a fresh decision token (preserving the org binding), and renders the approve/reject confirm page inline — no email.',
        params: ApprovalParamsSchema,
      },
    },
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
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

      // Mint a fresh token pair, preserving the original org binding (so the
      // decision handler's parent_org_id check still passes), and land the
      // reviewer on the confirm page directly.
      const { approveToken, rejectToken } = await mintApprovalTokenPair(aggregatorId, verified.org);
      const effectiveIntent = verified.intent === 'reject' ? 'reject' : 'approve';
      return sendHtml(
        reply,
        200,
        renderConfirmPage({
          aggregatorId,
          intent: effectiveIntent,
          token: effectiveIntent === 'reject' ? rejectToken : approveToken,
          applicantEmail: lookup.kcUser.email,
          association: lookup.aggregator.name,
          aggregatorType: lookup.aggregator.type ?? lookup.aggregator.actorType,
          postUrl: `${config.PUBLIC_API_URL}/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
          expiresInText: formatApprovalTtl(config.APPROVAL_TOKEN_TTL_SECONDS),
        }),
      );
    },
  );
}

interface PriorDecision {
  decision: 'approved' | 'rejected';
}

/**
 * Maps `aggregators.status` to a prior-decision marker. Returning `null`
 * means the row is still in `pending` and the admin click should proceed.
 *
 * `retired` is treated as a prior approval (the aggregator was once active
 * and was later retired) so the approve button doesn't reactivate a retired
 * account behind the admin's back.
 */
function decisionFromStatus(status: Aggregator['status']): PriorDecision | null {
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

type LookupOk = { ok: true; aggregator: Aggregator; kcUser: IdpUser };
type LookupErr = { ok: false; status: number; html: string };

async function loadAggregatorAndUser(aggregatorId: string): Promise<LookupOk | LookupErr> {
  const store = getAggregatorStore();
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
  return { ok: true, aggregator: stored.value, kcUser: kc.value };
}

function isIntent(v: unknown): v is 'approve' | 'reject' {
  return v === 'approve' || v === 'reject';
}

/**
 * Display name preference: Beckn contact.name → KC firstName+lastName →
 * email. Aggregator's `contact.name` is filled at registration; KC names
 * only appear after the applicant completes the Update Profile flow.
 */
function applicantNameOf(lookup: LookupOk): string {
  const contactName = lookup.aggregator.contact.name;
  if (contactName) return contactName;
  const parts = [lookup.kcUser.firstName, lookup.kcUser.lastName].filter((p): p is string =>
    Boolean(p),
  );
  return parts.length > 0 ? parts.join(' ') : lookup.kcUser.email;
}
