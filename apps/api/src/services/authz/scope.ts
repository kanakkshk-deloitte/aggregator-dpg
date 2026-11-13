/**
 * Reach checks for the console routes (`@aggregator-dpg/api`).
 *
 * An admin reaches the orgs it owns and their coordinators; the network admin
 * also reaches the root. Nobody else reaches anything. Out of reach answers
 * 404, not 403, so ids cannot be probed. Whether the actor may use a route at
 * all (403) is decided earlier by the route guard.
 *
 * Pure functions over a resolved {@link Actor}; no I/O.
 */

import type { Actor } from '../auth/actor/index.js';

/**
 * The org ids the actor reaches by ownership: the active orgs it owns, and the
 * root for the network admin.
 *
 * @param actor - A resolved admin actor.
 * @returns Owned org ids; empty for anyone but an admin.
 */
export function reachableOrgIds(actor: Actor): string[] {
  if (actor.userType !== 'admin') return [];
  return actor.orgs.filter((o) => o.relation === 'owner').map((o) => o.id);
}

/**
 * Whether an org is within the actor's reach.
 *
 * @param actor - A resolved actor.
 * @param orgId - The target org (null never reaches).
 * @returns `true` when reachable.
 */
export function reachesOrg(actor: Actor, orgId: string | null): boolean {
  if (!orgId) return false;
  return reachableOrgIds(actor).includes(orgId);
}

/**
 * Narrows a requested org filter to the actor's reach.
 *
 * An out-of-reach `org_id` yields an empty page, same as an org with no matches.
 *
 * @param actor - A resolved admin actor.
 * @param requested - The `org_id` filter, if any.
 * @returns The ids to search.
 */
export function scopeOrgFilter(actor: Actor, requested?: string): string[] {
  return narrowOrgFilter(reachableOrgIds(actor), requested);
}

/**
 * Narrows a requested org filter to a set of orgs: one outside the set yields
 * "no orgs" (an empty page).
 *
 * @param ids - The allowed org ids.
 * @param requested - The `org_id` filter, if any.
 * @returns The ids to search.
 */
export function narrowOrgFilter(ids: string[], requested?: string): string[] {
  if (requested === undefined) return ids;
  return ids.includes(requested) ? [requested] : [];
}
