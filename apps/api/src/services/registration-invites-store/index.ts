/**
 * Public surface and factory for the registration-invites store (`@aggregator-dpg/api`).
 *
 * Returns a process-wide singleton. Tests override it with
 * `_setRegistrationInvitesStore`.
 */

import type { RegistrationInvitesStoreBase } from './interface.js';
import { PostgresRegistrationInvitesStore } from './postgres.js';

let instance: RegistrationInvitesStoreBase | null = null;

/** Returns the shared invites store, created on first call. */
export function getRegistrationInvitesStore(): RegistrationInvitesStoreBase {
  if (instance) return instance;
  instance = new PostgresRegistrationInvitesStore();
  return instance;
}

/** Test helper; replaces the singleton. */
export function _setRegistrationInvitesStore(s: RegistrationInvitesStoreBase | null): void {
  instance = s;
}

export { RegistrationInvitesStoreBase } from './interface.js';
export type {
  RegistrationInvite,
  RegistrationInviteStatus,
  CreateInviteInput,
  RefreshInviteInput,
  InviteStoreError,
  InviteStoreResult,
} from './interface.js';
export { InMemoryRegistrationInvitesStore } from './memory.js';
export { PostgresRegistrationInvitesStore } from './postgres.js';
export { RegistrationInvitesStoreFake, buildRegistrationInvite } from './testing.js';
