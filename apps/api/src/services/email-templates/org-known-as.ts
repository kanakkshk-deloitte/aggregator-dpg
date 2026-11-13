/**
 * Owner notice of a parent owner's change (`@aggregator-dpg/api`).
 *
 * Tells an org's owner that the owner of the parent org changed what the org
 * is known as. Names no values.
 * Copy lives under `org_known_as.*`.
 */

import { renderCase, type RenderedEmail } from './render-case.js';

/** Template inputs for the parent-owner notice. */
export interface OrgKnownAsVars {
  /** The organisation acted on. */
  orgName: string;
  /** The parent organisation, whose owner made the change. */
  parentName: string;
  /** The console URL. */
  consoleUrl: string;
}

/**
 * Renders the parent-owner notice.
 *
 * @param v - Organisation, parent organisation and console link.
 * @returns The `subject`, `html`, and `text` parts ready for the mailer.
 */
export function renderOrgKnownAs(v: OrgKnownAsVars): RenderedEmail {
  return renderCase('org_known_as', {
    orgName: v.orgName,
    parentName: v.parentName,
    consoleUrl: v.consoleUrl,
  });
}
