/**
 * Org-detail rendering for a coordinator (`@aggregator-dpg/api`).
 *
 * `url`, `locations`, company and GST number belong to the coordinator's org.
 * Each field comes from the org when set, else from `users.legacy_org_details`,
 * else empty. Shared by the Postgres and in-memory stores.
 */

import type { BecknLocation } from '@aggregator-dpg/shared-primitives/aggregator';
import type { LegacyOrgDetails } from './interface.js';

/**
 * The org's own detail values: `url` and `gstNumber` are the `website` and
 * `gst_number` keys of `organisations.profile`; the others are columns.
 */
export interface OrgDetailColumns {
  url: string | null;
  locations: BecknLocation[];
  legalName: string | null;
  gstNumber: string | null;
}

/** The rendered org details of one coordinator. */
export interface RenderedOrgDetails {
  url: string | null;
  locations: BecknLocation[];
  company: string | undefined;
  gstNumber: string | undefined;
}

/** A trimmed, non-empty string, or `undefined`. */
function present(v: string | null | undefined): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/**
 * Renders a coordinator's org details from its org, falling back per field to
 * its own values.
 *
 * @param org - The org's columns, or `null` when the org is unknown.
 * @param legacy - The coordinator's `legacy_org_details`, or `null`.
 * @returns The values to put on the domain object.
 */
export function renderOrgDetails(
  org: OrgDetailColumns | null,
  legacy: LegacyOrgDetails | null | undefined,
): RenderedOrgDetails {
  const own = legacy ?? {};
  const orgLocations = org?.locations ?? [];
  const ownLocations = Array.isArray(own.locations) ? own.locations : [];
  return {
    url: present(org?.url) ?? present(own.url) ?? null,
    locations: orgLocations.length > 0 ? orgLocations : ownLocations,
    company: present(org?.legalName) ?? present(own.company),
    gstNumber: present(org?.gstNumber) ?? present(own.gstNumber),
  };
}
