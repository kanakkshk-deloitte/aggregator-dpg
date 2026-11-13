/**
 * Public surface and factory for the user store (`@aggregator-dpg/api`).
 *
 * Returns a process-wide singleton. Tests override it with `_setUserStore`.
 */

import type { UserStoreBase } from './interface.js';
import { PostgresUserStore } from './postgres.js';

let instance: UserStoreBase | null = null;

/**
 * Returns the shared user store, created on first call.
 */
export function getUserStore(): UserStoreBase {
  if (instance) return instance;
  instance = new PostgresUserStore();
  return instance;
}

/** Test helper; replaces the singleton. */
export function _setUserStore(s: UserStoreBase | null): void {
  instance = s;
}

export { UserStoreBase } from './interface.js';
export type { Coordinator, CreateCoordinatorInput, StoreError, StoreResult } from './interface.js';
export { InMemoryUserStore } from './memory.js';
export { PostgresUserStore } from './postgres.js';
export { UserStoreFake, buildCoordinator, buildCreateCoordinatorInput } from './testing.js';
