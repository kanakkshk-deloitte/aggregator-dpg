/**
 * Which organisations' coordinators an admin may manage (`@aggregator-dpg/api`,
 * RBAC, #873).
 *
 * Reach follows ownership: an admin reaches the coordinators of the
 * aggregator organisations it owns, never those of a child organisation; the
 * network admin follows the same rule (the Default org, and any other
 * organisation it owns). Managing coordinators (list, read, decide, edit,
 * invite) also needs `org.manage` in the coordinator's organisation, which an
 * organisation's owner holds through Org Admin. A root-held `org.manage` (or
 * `network.administer` for viewing) keeps the owned reach without narrowing it.
 */

import type { FastifyRequest } from 'fastify';
import type { Capability } from '@aggregator-dpg/rbac';
import { ownedOrgIds, type Actor } from '../auth/actor/index.js';
import { permissionsByOrg } from './guard.js';
import { getRbacRuntime } from './runtime.js';

/** Why the scope is asked for: changing coordinators, or only reading them. */
export type ScopePurpose = 'manage' | 'view';

/** Root-held permissions that open every organisation, per purpose. */
const ROOT_WIDE: Record<ScopePurpose, readonly Capability[]> = {
  manage: ['org.manage'],
  view: ['org.manage', 'network.administer'],
};

/**
 * The organisations whose coordinators the actor may manage, or view.
 *
 * Narrows reach only in `enforce` mode; in `log` mode a narrower answer is
 * logged and reach is returned, and with access control off reach is
 * returned unchanged.
 *
 * @param req - The request (for its logger).
 * @param actor - The resolved actor.
 * @param rootId - The root organisation's id, when known.
 * @param purpose - `manage` (default) or `view` (read-only).
 * @returns The organisation ids.
 */
export async function manageableOrgIds(
  req: FastifyRequest,
  actor: Actor,
  rootId: string | null,
  purpose: ScopePurpose = 'manage',
): Promise<string[]> {
  const reach = actor.userType === 'admin' ? ownedOrgIds(actor) : [];
  const rt = getRbacRuntime();
  if (!rt) return reach;
  const perms = await permissionsByOrg(req, actor, rootId);
  if (!perms) return reach;
  const manages = (orgId: string) => (perms[orgId] ?? []).includes('org.manage');
  const rootPerms = rootId ? (perms[rootId] ?? []) : [];
  if (ROOT_WIDE[purpose].some((c) => rootPerms.includes(c))) return reach;
  const owned = actor.orgs
    .filter((o) => o.orgType === 'aggregator' && manages(o.id))
    .map((o) => o.id);
  const narrowed = reach.filter((id) => owned.includes(id));
  if (narrowed.length === reach.length) return reach;
  // Log before returning, in both modes. `enforce` is the mode that actually
  // withholds organisations, and the caller turns that into a 404 that looks
  // exactly like a missing record — so without this line the one outcome worth
  // auditing is the one that leaves no trace. The route guard's `rbac.decide`
  // entries do not cover it either: this scope is computed outside that path.
  const enforcing = rt.mode === 'enforce';
  req.log.warn({
    operation: 'rbac.manage_scope',
    purpose,
    status: enforcing ? 'failure' : 'skipped',
    user_id: actor.userId,
    mode: rt.mode,
    reasons: ['org_manage_not_held'],
    org_count: narrowed.length,
  });
  return enforcing ? narrowed : reach;
}

/**
 * Whether an organisation is in a manage scope.
 *
 * @param ids - From {@link manageableOrgIds}.
 * @param orgId - The organisation, or null for none.
 * @returns True when the organisation may be managed.
 */
export function inManageScope(ids: string[], orgId: string | null): boolean {
  return orgId !== null && ids.includes(orgId);
}
