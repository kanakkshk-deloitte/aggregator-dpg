/**
 * Test fake and builders for the organisation store, in `@aggregator-dpg/api`.
 *
 * Other modules import the fake from here, not the in-memory store.
 */

import { InMemoryOrganisationStore } from './memory.js';
import { contactId } from '@aggregator-dpg/shared-primitives/contact';
import { SYSTEM_KNOWN_AS, type KnownAsValues } from '@aggregator-dpg/shared-primitives/user-org';
import { DEFAULT_ORG_SLUG, type Organisation, type TreeRules } from './interface.js';
export { NO_CONSENT_WRITE } from '../consent-ledger/hook.js';

export class OrganisationStoreFake extends InMemoryOrganisationStore {
  /**
   * Pre-seed rows, bypassing create()'s slug check. Callers are responsible
   * for keeping seeded data internally consistent.
   *
   * @param rows - Rows to insert before the test runs.
   */
  seed(rows: Organisation[]): void {
    for (const r of rows) this.byId.set(r.id, r);
  }

  /**
   * Seeds the network-facilitator root (only `findRoot` returns it).
   *
   * @param row - The root org.
   */
  seedRoot(row: Organisation): void {
    this.root = row;
  }

  /**
   * Seeds the "known as" values an org (or the root) defines for its children.
   *
   * @param orgId - The org id.
   * @param values - The list, in order; replaces any seeded list.
   */
  seedKnownAsValues(orgId: string, values: KnownAsValues): void {
    this.knownAsLists.set(
      orgId,
      values.map((e) => ({ ...e })),
    );
  }

  /** Reset between tests. */
  reset(): void {
    this.byId.clear();
    this.knownAsLists.clear();
    this.root = null;
  }
}

/**
 * Deterministic test data builder for an {@link Organisation}.
 *
 * @param overrides - Field overrides; defaults are valid and snapshot-stable.
 * @returns A fully-populated org row.
 */
export function buildOrganisation(overrides: Partial<Organisation> = {}): Organisation {
  const createdAt = overrides.createdAt ?? new Date('2026-01-01T00:00:00Z');
  const ownerEmail = overrides.ownerEmail ?? 'owner@test.local';
  const ownerPhone = overrides.ownerPhone !== undefined ? overrides.ownerPhone : null;
  return {
    id: '00000000-0000-0000-0000-0000000000a1',
    slug: 'test-org',
    displayName: 'Test Org',
    state: null,
    contactId: contactId(ownerEmail, ownerPhone),
    // Derived from the owner's contact, so two orgs share an owner exactly when they share the person.
    ownerUserId: `owner-${contactId(ownerEmail, ownerPhone).slice(0, 16)}`,
    ownerEmail,
    ownerPhone,
    ownerName: null,
    ownerKcSub: null,
    kcGroupId: null,
    profile: {},
    profileRef: null,
    status: 'pending',
    createdAt,
    updatedAt: createdAt,
    updatedBy: null,
    rejectedAt: null,
    isDefault: false,
    locations: [],
    legalName: null,
    knownAs: SYSTEM_KNOWN_AS.key,
    knownAsName: SYSTEM_KNOWN_AS.name,
    depth: 1,
    parentId: null,
    parentName: null,
    description: null,
    ...overrides,
  };
}

/**
 * Builds the fixed Default org: active, owned by the network admin.
 *
 * @param overrides - Field overrides.
 * @returns The Default org row.
 */
export function buildDefaultOrg(overrides: Partial<Organisation> = {}): Organisation {
  return buildOrganisation({
    id: '00000000-0000-0000-0000-0000000000d0',
    slug: DEFAULT_ORG_SLUG,
    displayName: 'Default',
    ownerEmail: 'network-admin@nf.invalid',
    status: 'active',
    isDefault: true,
    ...overrides,
  });
}

/**
 * Tree rules that refuse nothing a test normally builds.
 *
 * Depth up to 10, no per-parent limit and a large total.
 *
 * @param overrides - Rules to replace.
 * @returns The rules.
 */
export function permissiveTreeRules(overrides: Partial<TreeRules> = {}): TreeRules {
  return {
    maxDepth: 10,
    maxChildren: null,
    maxTotalOrgs: 100_000,
    ...overrides,
  };
}
