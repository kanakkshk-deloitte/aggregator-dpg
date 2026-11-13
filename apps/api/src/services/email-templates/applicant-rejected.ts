/**
 * Applicant-rejected email. Polite decline; optional reason rendered verbatim
 * if supplied by the admin.
 *
 * Belongs to `@aggregator-dpg/api`. Copy lives under `applicant_rejected.*`.
 * The layout picks one of two greetings: with a name, or without one (the org
 * flow has no owner name).
 */

import { renderCase, type RenderedEmail } from './render-case.js';

/**
 * Template inputs for the applicant-rejected email.
 */
export interface ApplicantRejectedVars {
  /**
   * Personal name of the applicant contact. Optional: the org flow has no owner name.
   */
  contactName?: string | undefined;
  association: string;
  reason?: string | undefined;
  /**
   * What was rejected — drives the subject and the opening line. Use
   * `organisation` for the org flow, `coordinator` for coordinators (`aggregator` when unset).
   */
  entityLabel?: string | undefined;
}

/**
 * Renders the applicant-rejected email.
 *
 * @param v - Association, optional contact name, optional reason and label.
 * @returns The `subject`, `html`, and `text` parts ready for the mailer.
 */
export function renderApplicantRejected(v: ApplicantRejectedVars): RenderedEmail {
  return renderCase('applicant_rejected', {
    contactName: v.contactName,
    association: v.association,
    entityLabel: v.entityLabel ?? 'aggregator',
    reason: v.reason,
  });
}
