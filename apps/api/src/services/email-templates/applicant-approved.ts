/**
 * Applicant-approved email — sent on `approve`. Welcomes the user and points
 * them at the portal sign-in page. Uses OTP login, so no password is included.
 *
 * Belongs to `@aggregator-dpg/api`. Copy lives in the properties layers under
 * `applicant_approved.*` and the layout on the case registry entry; this
 * module gives the case a typed signature.
 */

import { renderCase, type RenderedEmail } from './render-case.js';

/**
 * Template inputs for the applicant-approved email.
 */
export interface ApplicantApprovedVars {
  contactName: string;
  association: string;
  /** Email or phone the user registered with. */
  identifier: string;
  signInUrl: string;
}

/**
 * Renders the applicant-approved email.
 *
 * @param v - Contact name, association, registered identifier, sign-in URL.
 * @returns The `subject`, `html`, and `text` parts ready for the mailer.
 */
export function renderApplicantApproved(v: ApplicantApprovedVars): RenderedEmail {
  return renderCase('applicant_approved', {
    contactName: v.contactName,
    association: v.association,
    identifier: v.identifier,
    signInUrl: v.signInUrl,
  });
}
