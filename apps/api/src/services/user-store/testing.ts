/**
 * Public testing surface for the api coordinator store.
 *
 * Other modules import the fake from here, not from the in-memory implementation.
 */

import { contactId } from '@aggregator-dpg/shared-primitives/contact';
import { InMemoryUserStore, MEMORY_DEFAULT_ORG_ID } from './memory.js';
import type { OrgDetailColumns } from './org-details.js';
import type { Coordinator, CreateCoordinatorInput } from './interface.js';
import { NO_CONSENT_WRITE } from '../consent-ledger/hook.js';

export { NO_CONSENT_WRITE };
import type { BecknContact, ConsentRecord } from '@aggregator-dpg/shared-primitives/aggregator';

export class UserStoreFake extends InMemoryUserStore {
  /**
   * Pre-seeds the store with rows.
   * Skips the checks `create()` applies; callers keep seeded data consistent.
   */
  seed(rows: Coordinator[]): void {
    for (const r of rows) this.indexInsert(r);
  }

  /**
   * Seeds an org's detail columns, rendered for its coordinators.
   *
   * @param orgId - The org id.
   * @param details - The org's `url` / `locations` / `legalName` / `gstNumber`.
   */
  seedOrgDetails(orgId: string, details: Partial<OrgDetailColumns>): void {
    this.orgDetails.set(orgId, {
      url: null,
      locations: [],
      legalName: null,
      gstNumber: null,
      ...details,
    });
  }

  /**
   * Seeds an invite's address, read back as `inviteEmail` for that `inviteId`.
   *
   * @param jti - The invite id.
   * @param email - The invited address.
   */
  seedInviteEmail(jti: string, email: string): void {
    this.inviteEmails.set(jti, email);
  }

  /**
   * Changes which org id counts as the Default org.
   *
   * @param orgId - The Default org's id.
   */
  setDefaultOrgId(orgId: string): void {
    this.defaultOrgId = orgId;
  }

  /**
   * Synchronous read of a seeded row (test setup only).
   *
   * @param id - Row id.
   * @returns The row.
   * @throws Error when absent.
   */
  findByIdSync(id: string): Coordinator {
    const row = this.byId.get(id);
    if (!row) throw new Error(`no aggregator ${id}`);
    return row;
  }

  /** Reset between tests. */
  reset(): void {
    this.byId.clear();
    this.bySlug.clear();
    this.byPhone.clear();
    this.byEmail.clear();
    this.orgDetails.clear();
    this.legacy.clear();
    this.defaultOrgId = MEMORY_DEFAULT_ORG_ID;
  }

  /**
   * Overwrites `updatedAt` on an existing row, to back-date it in tests.
   *
   * @param id - Coordinator UUID to back-date.
   * @param date - The timestamp to set on `updatedAt`.
   */
  __setUpdatedAt(id: string, date: Date): void {
    const row = this.byId.get(id);
    if (!row) throw new Error(`UserStoreFake.__setUpdatedAt: id not found: ${id}`);
    this.byId.set(id, { ...row, updatedAt: date });
  }
}

const DEFAULT_CONTACT: BecknContact = {
  name: 'Default Contact',
  phone: '+919999999990',
  email: 'default@test.local',
};

const DEFAULT_CONSENT: ConsentRecord = {
  value: true,
  given_at: '2026-01-01T00:00:00.000Z',
  valid_till: '2027-01-01T00:00:00.000Z',
};

/** Test data builder with deterministic defaults. */
export function buildCoordinator(overrides: Partial<Coordinator> = {}): Coordinator {
  const createdAt = overrides.createdAt ?? new Date('2026-01-01T00:00:00Z');
  const contact = overrides.contact ?? DEFAULT_CONTACT;
  return {
    id: '00000000-0000-0000-0000-000000000001',
    orgSlug: 'test-org-0001',
    actorType: 'aggregator',
    name: 'Test Org',
    type: overrides.type ?? null,
    serves: overrides.serves ?? (overrides.type ? [overrides.type] : []),
    url: null,
    contactId: contactId(contact.email, contact.phone),
    contact,
    contactPhone: overrides.contactPhone ?? contact.phone,
    contactEmail: overrides.contactEmail ?? contact.email.toLowerCase(),
    locations: [],
    consent: DEFAULT_CONSENT,
    profile: {},
    profileRef: null,
    status: 'pending',
    createdBy: 'system',
    updatedBy: 'system',
    createdAt,
    updatedAt: createdAt,
    signalstackOrgId: null,
    parentOrgId: MEMORY_DEFAULT_ORG_ID,
    isDefaultOrg: true,
    inviteEmail: null,
    inviteId: null,
    rejectedAt: null,
    ...overrides,
  };
}

export function buildCreateCoordinatorInput(
  overrides: Partial<CreateCoordinatorInput> = {},
): CreateCoordinatorInput {
  return {
    orgSlug: 'test-org-0001',
    name: 'Test Org',
    type: null,
    contact: DEFAULT_CONTACT,
    recordConsent: NO_CONSENT_WRITE,
    consent: DEFAULT_CONSENT,
    createdBy: 'system',
    updatedBy: 'system',
    orgId: MEMORY_DEFAULT_ORG_ID,
    ...overrides,
  };
}
