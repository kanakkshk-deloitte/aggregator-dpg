/**
 * Public surface and factory for the aggregator-org store (`@aggregator-dpg/api`).
 *
 * Returns a process-wide singleton. Tests override via `_setOrganisationStore`.
 */

import type { OrganisationStoreBase } from './interface.js';
import { PostgresOrganisationStore } from './postgres.js';

let instance: OrganisationStoreBase | null = null;

/** Returns the shared org store. Lazy-initialised on first call. */
export function getOrganisationStore(): OrganisationStoreBase {
  if (instance) return instance;
  instance = new PostgresOrganisationStore();
  return instance;
}

/** Test helper — replace the singleton. */
export function _setOrganisationStore(s: OrganisationStoreBase | null): void {
  instance = s;
}

export { OrganisationStoreBase, DEFAULT_ORG_SLUG } from './interface.js';
export type {
  Organisation,
  CreateOrgInput,
  UpdateOrgPatch,
  OrgStoreError,
  OrgStoreResult,
  TreeRules,
} from './interface.js';
export { InMemoryOrganisationStore } from './memory.js';
export { PostgresOrganisationStore } from './postgres.js';
export { OrganisationStoreFake, buildOrganisation, buildDefaultOrg } from './testing.js';
