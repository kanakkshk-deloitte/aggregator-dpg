/**
 * Org-review notification for the org registration flow.
 *
 * Belongs to `@aggregator-dpg/api`. Uses the shared `sendReviewEmail`. For
 * orgs, the URL segment is `orgs` and the token has no `org` claim. The review
 * goes to the owner of the parent organisation, which decides it; a top-level
 * organisation (under the network) goes to the network admins. Used by org
 * submit and org refresh.
 */

import type { FastifyBaseLogger } from 'fastify';
import { httpError } from '../errors/http-error.js';
import { getOrganisationStore } from './organisation-store/index.js';
import { parseAdminEmails, sendReviewEmail } from './registration-notify.js';

/** Inputs needed to render and deliver the org-review email. */
export interface OrgReviewNotifyInput {
  orgId: string;
  displayName: string;
  ownerEmail: string;
  /** Org owner's phone (E.164) — shown in the review email's Phone row. */
  ownerPhone: string;
  /** Parent organisation's id; `null` or the root for a top-level organisation. */
  parentId: string | null;
  /** Parent organisation's name; omitted when unknown. */
  parentName?: string | null;
  /** Reviewers already looked up with {@link orgReviewRecipients}; looked up from `parentId` when absent. */
  recipients?: string[];
}

/**
 * Who reviews a new organisation: the parent organisation's owner, or the
 * network admins when the parent is the network.
 *
 * @param parentId - The parent organisation's id, or `null`.
 * @param log - Logs a parent that is neither an aggregator org nor the root.
 * @returns The recipient emails.
 * @throws {HttpError} `DB_UNAVAILABLE` when the parent or the root cannot be read.
 */
export async function orgReviewRecipients(
  parentId: string | null,
  log?: FastifyBaseLogger,
): Promise<string[]> {
  if (parentId === null) return parseAdminEmails();
  const parent = await getOrganisationStore().findById(parentId);
  if (!parent.ok) {
    throw httpError('DB_UNAVAILABLE', {
      cause: new Error(parent.error.message),
      fields: { sub_operation: 'orgStore.findById.parent' },
    });
  }
  if (parent.value) return [parent.value.ownerEmail];
  // findById sees aggregator orgs only, so the root lands here; anything else is unexpected.
  const root = await getOrganisationStore().findRoot();
  if (!root.ok) {
    throw httpError('DB_UNAVAILABLE', {
      cause: new Error(root.error.message),
      fields: { sub_operation: 'orgStore.findRoot' },
    });
  }
  if (root.value?.id !== parentId) {
    log?.warn(
      { operation: 'org-registration-notify.orgReviewRecipients', parent_id: parentId },
      'parent is neither an aggregator org nor the root; sending the review to the network admins',
    );
  }
  return parseAdminEmails();
}

/**
 * Mints org approve/reject tokens and emails the reviewer a review link.
 *
 * @param input - Org id + display name + owner email/phone + parent for the email.
 * @param log - Request-scoped logger for delivery diagnostics.
 * @throws {HttpError} `TOKEN_MINT_FAILED` if either JWT cannot be minted.
 * @throws {HttpError} `DB_UNAVAILABLE` when the parent cannot be read.
 */
export async function sendOrgReviewEmail(
  input: OrgReviewNotifyInput,
  log: FastifyBaseLogger,
): Promise<void> {
  await sendReviewEmail(
    {
      subjectId: input.orgId,
      readPath: 'orgs',
      applicantName: input.displayName,
      applicantEmail: input.ownerEmail,
      applicantPhone: input.ownerPhone,
      recipients: input.recipients ?? (await orgReviewRecipients(input.parentId, log)),
      entityLabel: 'organisation',
      ...(input.parentName ? { parentName: input.parentName } : {}),
      logOperation: 'org-registration-notify.sendOrgReviewEmail',
    },
    log,
  );
}
