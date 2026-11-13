/**
 * Admin-review notification for the aggregator registration flow.
 *
 * Belongs to `@aggregator-dpg/api`. Mints the review token and sends the
 * reviewer email. Used by submit, resubmit and the "resend approval link"
 * endpoint, so all three send the same email.
 */

import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { mintApprovalToken, formatApprovalTtl } from './approval-token.js';
import { renderAdminReview } from './email-templates/index.js';
import { getMailer } from '@aggregator-dpg/mailer';
import { httpError } from '../errors/http-error.js';

/** Inputs needed to render and deliver the admin-review email. */
export interface AdminReviewNotifyInput {
  aggregatorId: string;
  applicantName: string;
  applicantEmail: string;
  applicantPhone: string;
  /** Invited email; highlighted to the approver when it differs. */
  invitedEmail?: string | undefined;
  /**
   * Parent org id. Minted into the token as the `org` claim, so the decision
   * is bound to the coordinator's org.
   */
  org?: string;
  /**
   * Recipient override, such as the org owner's email. When set, it replaces
   * the network-admin list.
   */
  recipientEmail?: string;
}

/**
 * Parses the comma-separated `ADMIN_EMAILS` env value.
 *
 * Strips quotes and whitespace; falls back to a default when unset.
 *
 * @returns The reviewer recipient list (never empty).
 */
export function parseAdminEmails(): string[] {
  let raw = (process.env.ADMIN_EMAILS ?? '').trim();
  if (
    raw.length >= 2 &&
    ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
  ) {
    raw = raw.slice(1, -1).trim();
  }
  const list = raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : ['admin@bluedots.local'];
}

/**
 * Mints the review token for the approve/reject page.
 *
 * The action is chosen on the page; the token's `intent` claim is ignored.
 *
 * @param subjectId - The record id bound as the token subject (aggregator or org id).
 * @param org - Optional parent-org id minted as the `org` claim (coordinator flow).
 * @returns The signed review token.
 * @throws {HttpError} `TOKEN_MINT_FAILED` if the JWT cannot be minted.
 */
export async function mintReviewToken(subjectId: string, org?: string): Promise<string> {
  const ttlSec = config.APPROVAL_TOKEN_TTL_SECONDS;
  const orgClaim = org ? { org } : {};
  try {
    return (
      await mintApprovalToken({ aggregatorId: subjectId, intent: 'approve', ttlSec, ...orgClaim })
    ).token;
  } catch (err) {
    throw httpError('TOKEN_MINT_FAILED', { cause: err });
  }
}

/** Inputs for rendering and sending a review email. */
export interface ReviewEmailInput {
  /** Record id: token subject, read-URL segment and email `registrationId`. */
  subjectId: string;
  /** Path segment under `/admin/v1/` for the read URL, e.g. `aggregator-registrations` or `orgs`. */
  readPath: string;
  applicantName: string;
  applicantEmail: string;
  applicantPhone: string;
  /** Invited email; highlighted when it differs from applicantEmail. */
  invitedEmail?: string | undefined;
  /** Resolved recipient list (network admins, or an org owner). */
  recipients: string[];
  /** Optional `org` token claim, for a coordinator. */
  org?: string;
  /** What was registered; sets the email subject and heading (default `aggregator`). */
  entityLabel?: string;
  /** Parent organisation's name, for an organisation registration. */
  parentName?: string;
  /** Log operation name for the delivery-failure warning. */
  logOperation: string;
}

/**
 * Mints the review token, renders the review email and sends it.
 *
 * Used for both coordinator and org review emails.
 *
 * @param input - Review-email fields and resolved recipients.
 * @param log - Request-scoped logger for delivery diagnostics.
 * @throws {HttpError} `TOKEN_MINT_FAILED` if the token cannot be minted.
 */
export async function sendReviewEmail(
  input: ReviewEmailInput,
  log: FastifyBaseLogger,
): Promise<void> {
  const token = await mintReviewToken(input.subjectId, input.org);
  const base = `${config.PUBLIC_API_URL}/admin/v1/${input.readPath}/read/${input.subjectId}`;
  const reviewMail = renderAdminReview({
    registrationId: input.subjectId,
    applicantName: input.applicantName,
    applicantEmail: input.applicantEmail,
    applicantPhone: input.applicantPhone,
    ...(input.invitedEmail ? { invitedEmail: input.invitedEmail } : {}),
    association: input.applicantName,
    ...(input.entityLabel ? { entityLabel: input.entityLabel } : {}),
    ...(input.parentName ? { parent: input.parentName } : {}),
    reviewUrl: `${base}?token=${encodeURIComponent(token)}`,
    submittedAt: new Date(),
    expiresInText: formatApprovalTtl(config.APPROVAL_TOKEN_TTL_SECONDS),
  });

  const mailResult = await getMailer().send({
    to: input.recipients,
    subject: reviewMail.subject,
    html: reviewMail.html,
    text: reviewMail.text,
  });
  if (!mailResult.ok) {
    log.warn(
      {
        operation: input.logOperation,
        status: 'failure',
        sub_operation: 'mailer.send',
        code: mailResult.error.code,
        cause: mailResult.error.message,
      },
      'review email delivery failed — record still saved',
    );
  }
}

/**
 * Sends a fresh review link for a coordinator registration.
 *
 * Goes to the reviewers, or to the org owner when the coordinator has an org.
 *
 * @param input - Registration id + applicant identity for the email body.
 * @param log - Request-scoped logger for delivery diagnostics.
 * @throws {HttpError} `TOKEN_MINT_FAILED` if the token cannot be minted.
 */
export async function sendAdminReviewEmail(
  input: AdminReviewNotifyInput,
  log: FastifyBaseLogger,
): Promise<void> {
  await sendReviewEmail(
    {
      subjectId: input.aggregatorId,
      readPath: 'aggregator-registrations',
      applicantName: input.applicantName,
      applicantEmail: input.applicantEmail,
      applicantPhone: input.applicantPhone,
      ...(input.invitedEmail ? { invitedEmail: input.invitedEmail } : {}),
      recipients: input.recipientEmail ? [input.recipientEmail] : parseAdminEmails(),
      ...(input.org ? { org: input.org } : {}),
      // Set explicitly so reviewers can tell coordinator emails from org emails.
      entityLabel: 'aggregator coordinator',
      logOperation: 'registration-notify.sendAdminReviewEmail',
    },
    log,
  );
}
