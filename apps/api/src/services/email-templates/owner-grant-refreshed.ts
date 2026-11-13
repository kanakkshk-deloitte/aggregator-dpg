/**
 * Owner grant-refreshed email. Sent when an org owner requests a fresh
 * invite-management link because the previous one expired.
 *
 * Belongs to `@aggregator-dpg/api`. Separate from `org-owner-approved` so it
 * does not read as a repeat approval. No sign-in button. Copy lives under
 * `owner_grant_refreshed.*`.
 */

import { renderCase, type RenderedEmail } from './render-case.js';

/**
 * Template inputs for the owner grant-refreshed email.
 */
export interface OwnerGrantRefreshedVars {
  /** The organisation the refreshed link manages invites for. */
  orgName: string;
  /** The invite-management page URL carrying the fresh grant token. */
  inviteUrl: string;
}

/**
 * Renders the owner grant-refreshed email.
 *
 * @param v - Organisation name and the fresh invite-management link.
 * @returns The `subject`, `html`, and `text` parts ready for the mailer.
 */
export function renderOwnerGrantRefreshed(v: OwnerGrantRefreshedVars): RenderedEmail {
  return renderCase('owner_grant_refreshed', {
    orgName: v.orgName,
    inviteUrl: v.inviteUrl,
  });
}
