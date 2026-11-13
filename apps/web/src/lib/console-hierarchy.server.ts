/**
 * Server-side reads of the organisation hierarchy for the console (`apps/web`):
 * every organisation under the network, or within the viewer's reach.
 *
 * @module apps/web/src/lib/console-hierarchy.server
 */

import type { OrgSearchResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { consoleRead } from './console-api.server';

/** Organisations read per page, and the most pages read. */
const PAGE = 100;
const MAX_PAGES = 5;

/**
 * Reads the top-level organisations, directly under the network, up to the page cap.
 *
 * @param rootId - The network's id.
 * @returns The organisations, and whether more exist than were read.
 */
export async function readNetworkOrgs(
  rootId: string,
): Promise<{ orgs: OrgSearchResponse['orgs']; more: boolean }> {
  const orgs: OrgSearchResponse['orgs'] = [];
  let cursor: string | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page: OrgSearchResponse = await consoleRead<OrgSearchResponse>('/v1/org/search', {
      filter: { parent_id: rootId },
      limit: PAGE,
      ...(cursor ? { cursor } : {}),
    });
    orgs.push(...page.orgs);
    cursor = page.next_cursor;
    if (!cursor) return { orgs, more: false };
  }
  return { orgs, more: true };
}

/**
 * Reads every organisation within the viewer's reach, up to the page cap:
 * the ones the viewer owns and the ones directly under them.
 *
 * @returns The organisations, any status.
 */
export async function readReachableOrgs(): Promise<OrgSearchResponse['orgs']> {
  const orgs: OrgSearchResponse['orgs'] = [];
  let cursor: string | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page: OrgSearchResponse = await consoleRead<OrgSearchResponse>('/v1/org/search', {
      limit: PAGE,
      ...(cursor ? { cursor } : {}),
    });
    orgs.push(...page.orgs);
    cursor = page.next_cursor;
    if (!cursor) break;
  }
  return orgs;
}
