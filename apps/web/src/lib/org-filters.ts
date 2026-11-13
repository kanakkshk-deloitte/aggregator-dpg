/**
 * Organisation status filters and counts for the console tiles and lists
 * (`apps/web`). Plain functions, usable from server and client components.
 *
 * @module apps/web/src/lib/org-filters
 */

import type { OrgSearchResponse } from '@aggregator-dpg/shared-primitives/user-org';

type OrgRow = OrgSearchResponse['orgs'][number];

/** A tile filter: every organisation, or one status. */
export type OrgFilter = 'all' | 'active' | 'pending' | 'inactive';

export const ORG_FILTERS: readonly OrgFilter[] = ['all', 'active', 'pending', 'inactive'];

/** Organisations counted by filter. */
export type OrgCounts = Record<OrgFilter, number>;

/**
 * Counts organisations by status. The Default organisation is left out, as it
 * is from the organisation limit.
 *
 * @param orgs - The organisations, any status.
 * @returns The total and the count for each status filter.
 */
export function countOrgs(orgs: readonly OrgRow[]): OrgCounts {
  const counted = orgs.filter((o) => !o.is_default);
  const of = (s: OrgRow['status']) => counted.filter((o) => o.status === s).length;
  return {
    all: counted.length,
    active: of('active'),
    pending: of('pending'),
    inactive: of('inactive'),
  };
}

/**
 * Whether an organisation passes a filter. The Default organisation shows only
 * under `all`, because the status tiles do not count it.
 *
 * @param org - The organisation.
 * @param filter - The tile filter.
 */
export function matchesFilter(org: OrgRow, filter: OrgFilter): boolean {
  if (filter === 'all') return true;
  return !org.is_default && org.status === filter;
}
