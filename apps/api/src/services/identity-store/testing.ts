/**
 * Test helpers for the identity store (`@aggregator-dpg/api`): the in-memory
 * fake and a builder.
 */

import { IDP_PROVIDER } from '../idp-admin/provider.js';
import { InMemoryIdentityStore, type IdentityLink } from './memory.js';

/** In-memory fake with a `seed()` helper. */
export class IdentityStoreFake extends InMemoryIdentityStore {
  /** Pre-loads links. */
  seed(links: IdentityLink[]): void {
    this.links.push(...links);
  }
}

/** Builds one link with sensible defaults. */
export function buildIdentity(overrides: Partial<IdentityLink> = {}): IdentityLink {
  return {
    userId: '00000000-0000-0000-0000-000000000001',
    provider: IDP_PROVIDER,
    subject: 'kc-sub-1',
    ...overrides,
  };
}
