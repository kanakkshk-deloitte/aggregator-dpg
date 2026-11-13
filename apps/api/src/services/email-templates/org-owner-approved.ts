/**
 * Org-owner approved email. Tells the org owner their organisation is live and
 * links to the portal sign-in page.
 *
 * Belongs to `@aggregator-dpg/api`. Copy lives under `org_owner_approved.*`.
 * With a link, the tail shows a lead, button and note; without one, a notice
 * that a link follows. The token is named `inviteUrl` so operator copy
 * overrides stay valid.
 */

import { renderCase, type RenderedEmail } from './render-case.js';

/**
 * Template inputs for the org-owner approved email.
 */
export interface OrgOwnerApprovedVars {
  /** The organisation's display name, as registered. */
  orgName: string;
  /** The owner email the organisation was registered with. */
  ownerEmail: string;
  /** The portal sign-in link. */
  inviteUrl?: string;
}

/**
 * Renders the org-owner approved email.
 *
 * @param v - Organisation name, owner email, and the optional sign-in link.
 * @returns The `subject`, `html`, and `text` parts ready for the mailer.
 */
export function renderOrgOwnerApproved(v: OrgOwnerApprovedVars): RenderedEmail {
  return renderCase('org_owner_approved', {
    orgName: v.orgName,
    ownerEmail: v.ownerEmail,
    inviteUrl: v.inviteUrl,
  });
}
