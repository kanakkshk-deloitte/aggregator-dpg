/**
 * Public surface + factory for the RBAC catalogue store (`@aggregator-dpg/api`,
 * R4). Returns a process-wide singleton; tests override it with
 * `_setRbacCatalogue`.
 */

import type { RbacCatalogueBase } from './interface.js';
import { PostgresRbacCatalogue } from './postgres.js';
import { TEST_RBAC_CATALOGUE_KEY } from './test-hook.js';

let instance: RbacCatalogueBase | null = null;

/**
 * Returns the shared catalogue store (lazy). An explicitly injected store wins;
 * otherwise, under the unit-test setup, the per-test in-memory store.
 *
 * @returns The catalogue store.
 */
export function getRbacCatalogue(): RbacCatalogueBase {
  if (instance) return instance;
  const testStore = (globalThis as Record<string, unknown>)[TEST_RBAC_CATALOGUE_KEY];
  if (testStore) return testStore as RbacCatalogueBase;
  instance = new PostgresRbacCatalogue();
  return instance;
}

/** Test helper — replace the singleton (`null` restores the default). */
export function _setRbacCatalogue(s: RbacCatalogueBase | null): void {
  instance = s;
}

export { RbacCatalogueBase } from './interface.js';
export type {
  CatalogueSnapshot,
  CatalogueStoreError,
  CatalogueStoreResult,
  StoredPermission,
} from './interface.js';
export { InMemoryRbacCatalogue } from './memory.js';
export { PostgresRbacCatalogue } from './postgres.js';
