/**
 * Test fake and builder for the registration-invites store (`@aggregator-dpg/api`).
 *
 * `seed()` sets exact row state; `buildRegistrationInvite()` returns a valid
 * default row.
 */

import { InMemoryRegistrationInvitesStore } from './memory.js';
import type { RegistrationInvite } from './interface.js';

export class RegistrationInvitesStoreFake extends InMemoryRegistrationInvitesStore {
  /**
   * Seeds the fake with pre-built invites, bypassing the public `create` API.
   *
   * @param invites - Rows to insert before the test runs.
   */
  seed(invites: RegistrationInvite[]): void {
    for (const inv of invites) this.store.set(inv.jti, { ...inv });
  }
}

/**
 * Builds a valid pending invite row for tests.
 *
 * @param overrides - Fields to override on the default row.
 * @returns A `RegistrationInvite` with deterministic defaults.
 */
export function buildRegistrationInvite(
  overrides: Partial<RegistrationInvite> = {},
): RegistrationInvite {
  return {
    jti: 'invite-seed-1',
    role: 'coordinator',
    parentOrgId: '00000000-0000-0000-0000-0000000000aa',
    email: 'coord@org.example',
    status: 'pending',
    expiresAt: new Date('2026-12-31T00:00:00Z'),
    createdBy: 'owner-sub',
    createdAt: new Date('2026-08-01T00:00:00Z'),
    consumedAt: null,
    ...overrides,
  };
}
