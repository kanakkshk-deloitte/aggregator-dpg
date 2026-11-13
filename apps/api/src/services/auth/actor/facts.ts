/**
 * Pure facts about a resolved actor, in the aggregator API (`@aggregator-dpg/api`).
 */

import type { Actor } from './interface.js';

/**
 * Whether the actor is the network admin: the owner of the root
 * (`network_facilitator`) organisation.
 *
 * @param actor - A resolved actor.
 * @returns `true` for the root's owner.
 */
export function isNetworkAdmin(actor: Actor): boolean {
  return actor.orgs.some((o) => o.orgType === 'network_facilitator' && o.relation === 'owner');
}

/**
 * The active aggregator orgs the actor owns (the root excluded).
 *
 * @param actor - A resolved actor.
 * @returns Org ids; empty for a coordinator.
 */
export function ownedOrgIds(actor: Actor): string[] {
  return actor.orgs
    .filter((o) => o.relation === 'owner' && o.orgType === 'aggregator')
    .map((o) => o.id);
}
