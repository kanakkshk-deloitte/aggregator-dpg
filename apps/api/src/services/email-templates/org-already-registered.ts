/**
 * Organisation-already-registered email — sent when someone submits the org
 * registration form for an organisation that is already approved and live.
 *
 * Belongs to `@aggregator-dpg/api`. Unlike `owner-grant-refreshed` ("my link
 * expired"), this acknowledges a repeat registration attempt. It carries the
 * coordinator invite link and no sign-in button.
 *
 * Always sent to the owner email on file, never the submitted address: the
 * form is anonymous, so mailing the submitted address would leak the invite
 * credential.
 *
 * Copy lives under `org_already_registered.*`.
 */

import { renderCase, type RenderedEmail } from './render-case.js';

/**
 * Template inputs for the organisation-already-registered email.
 */
export interface OrgAlreadyRegisteredVars {
  /** Display name of the organisation that is already registered. */
  orgName: string;
  /** The invite-management page URL carrying the grant token. */
  inviteUrl: string;
}

/**
 * Renders the organisation-already-registered email.
 *
 * @param v - Organisation name and the invite-management link.
 * @returns The `subject`, `html`, and `text` parts ready for the mailer.
 */
export function renderOrgAlreadyRegistered(v: OrgAlreadyRegisteredVars): RenderedEmail {
  return renderCase('org_already_registered', {
    orgName: v.orgName,
    inviteUrl: v.inviteUrl,
  });
}
