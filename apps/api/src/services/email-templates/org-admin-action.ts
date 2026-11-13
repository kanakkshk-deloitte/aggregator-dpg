/**
 * Owner notice of a network-admin action (`@aggregator-dpg/api`).
 *
 * Tells the org owner when a network admin edits the org's details or decides
 * one of its coordinators. The `action` phrase names what changed (field names
 * or the decision), never values.
 * Copy lives under `org_admin_action.*`.
 */

import { renderCase, type RenderedEmail } from './render-case.js';

/** Template inputs for the owner notice. */
export interface OrgAdminActionVars {
  /** The organisation acted on. */
  orgName: string;
  /** What was done, e.g. "updated the website and locations". No values. */
  action: string;
  /** The console URL. */
  consoleUrl: string;
}

/**
 * Renders the owner notice.
 *
 * @param v - Organisation, action phrase and console link.
 * @returns The `subject`, `html`, and `text` parts ready for the mailer.
 */
export function renderOrgAdminAction(v: OrgAdminActionVars): RenderedEmail {
  return renderCase('org_admin_action', {
    orgName: v.orgName,
    action: v.action,
    consoleUrl: v.consoleUrl,
  });
}
