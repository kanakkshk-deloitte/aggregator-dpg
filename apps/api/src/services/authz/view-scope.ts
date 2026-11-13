/**
 * Read-only reach one level below an owner's organisations (`@aggregator-dpg/api`).
 *
 * An owner manages the organisations it owns and views, read-only, their
 * direct children. Nothing deeper is visible. The network admin follows the
 * same rule: it owns the root, so it views the top-level organisations. Writes
 * keep the owned reach (`scope.ts`, `manage-scope.ts`); reads of organisations
 * use the view reach built here.
 */

import { getOrganisationStore } from '../organisation-store/index.js';
import type { OrgStoreResult } from '../organisation-store/index.js';
import { reachableOrgIds } from './scope.js';
import type { Actor } from '../auth/actor/index.js';

/**
 * Adds the direct children of the given organisations.
 *
 * @param ids - Organisation ids.
 * @returns The ids and their direct children.
 */
export async function withChildren(ids: string[]): Promise<OrgStoreResult<string[]>> {
  if (ids.length === 0) return { ok: true, value: ids };
  const children = await getOrganisationStore().childIds(ids);
  if (!children.ok) return children;
  return { ok: true, value: [...new Set([...ids, ...children.value])] };
}

/**
 * The organisations the actor may read: the ones it owns and their direct children.
 *
 * @param actor - The resolved actor.
 * @returns The ids; empty for anyone but an admin.
 */
export async function viewableOrgIds(actor: Actor): Promise<OrgStoreResult<string[]>> {
  return withChildren(reachableOrgIds(actor));
}

/**
 * Whether an organisation is only viewed, not owned: a direct child of the
 * actor's own organisations. Contacts there are always masked, and reads are
 * logged as such.
 *
 * @param actor - The resolved actor.
 * @param orgId - The organisation.
 * @returns `true` when the actor does not reach the organisation by ownership.
 */
export function isOnlyViewed(actor: Actor, orgId: string | null): boolean {
  return orgId === null || !reachableOrgIds(actor).includes(orgId);
}
