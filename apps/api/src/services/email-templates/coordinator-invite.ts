/**
 * Coordinator-invite email — sent to each recipient an org owner invites,
 * carrying the registration link with their personal invite token.
 *
 * Belongs to `@aggregator-dpg/api`. Copy lives under `coordinator_invite.*`.
 * The greeting is a derived token on the case registry entry, used inside `intro`.
 */

import { renderCase, type RenderedEmail } from './render-case.js';

/**
 * Template inputs for the coordinator-invite email.
 */
export interface CoordinatorInviteVars {
  /** Organisation the recipient is being invited to join. */
  orgName: string;
  /** Contact address of the inviting org (its owner) — sender identity + support. */
  inviterEmail: string;
  /** Registration link carrying the invite token. */
  inviteUrl: string;
  /** Absolute expiry, pre-formatted (e.g. "15 Sep 2026"). */
  expiresOn: string;
  /** Optional recipient name for a personal greeting (not stored/enforced). */
  recipientName?: string;
}

/**
 * Renders the coordinator-invite email.
 *
 * @param v - Org name, inviter contact, invite link, absolute expiry, optional name.
 * @returns The `subject`, `html`, and `text` parts ready for the mailer.
 */
export function renderCoordinatorInvite(v: CoordinatorInviteVars): RenderedEmail {
  return renderCase('coordinator_invite', {
    orgName: v.orgName,
    inviterEmail: v.inviterEmail,
    inviteUrl: v.inviteUrl,
    expiresOn: v.expiresOn,
    recipientName: v.recipientName,
  });
}
