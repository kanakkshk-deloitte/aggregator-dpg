/**
 * Invite-to-an-existing-account email (`@aggregator-dpg/api`).
 *
 * Sent instead of a coordinator invite when the address already belongs to an
 * account outside the inviting org. The inviter sees the same response as for
 * a fresh invite, so the console cannot probe other orgs' members. Copy lives
 * under `invite_existing_account.*`.
 */

import { renderCase, type RenderedEmail } from './render-case.js';

/** Template inputs for the existing-account invite email. */
export interface InviteExistingAccountVars {
  /** The inviting organisation. */
  orgName: string;
  /** The portal sign-in URL. */
  signInUrl: string;
}

/**
 * Renders the existing-account invite email.
 *
 * @param v - Organisation name and the sign-in link.
 * @returns The `subject`, `html`, and `text` parts ready for the mailer.
 */
export function renderInviteExistingAccount(v: InviteExistingAccountVars): RenderedEmail {
  return renderCase('invite_existing_account', { orgName: v.orgName, signInUrl: v.signInUrl });
}
