/**
 * Public surface and factory for the role-assignment store (`@aggregator-dpg/api`).
 *
 * Returns a process-wide singleton; tests override it with `_setRoleStore`.
 */

import type { RoleStoreBase } from './interface.js';
import { PostgresRoleStore } from './postgres.js';
import { TEST_ROLE_STORE_KEY } from './test-hook.js';

let instance: RoleStoreBase | null = null;

/**
 * Returns the shared role store, created on first use.
 *
 * An injected store wins; under unit tests, the per-test in-memory store is used.
 *
 * @returns The role store.
 */
export function getRoleStore(): RoleStoreBase {
  if (instance) return instance;
  const testStore = (globalThis as Record<string, unknown>)[TEST_ROLE_STORE_KEY];
  if (testStore) return testStore as RoleStoreBase;
  instance = new PostgresRoleStore();
  return instance;
}

/** Test helper; replaces the singleton (`null` restores the default). */
export function _setRoleStore(s: RoleStoreBase | null): void {
  instance = s;
}

export { RoleStoreBase } from './interface.js';
export type {
  AssignRoleInput,
  AuditEntry,
  RoleStoreError,
  RoleStoreResult,
  UserRoleRecord,
} from './interface.js';
export { InMemoryRoleStore } from './memory.js';
export { PostgresRoleStore } from './postgres.js';
