/**
 * Org-level view query.
 *
 * Belongs to `@aggregator-dpg/api`. Resolves an org's coordinators from the
 * `users.org_id` foreign key only; no Keycloak calls.
 */

import { getUserStore } from './user-store/index.js';
import type { Coordinator, StoreResult } from './user-store/index.js';

/**
 * Lists every coordinator belonging to the given org.
 *
 * @param orgId - `aggregator_orgs.id`.
 * @returns The org's coordinators (possibly empty); never throws.
 */
export async function listOrgCoordinators(orgId: string): Promise<StoreResult<Coordinator[]>> {
  return getUserStore().findByParentOrgId(orgId);
}
