/**
 * In-memory coordinator store for api unit tests.
 *
 * Matches the Postgres adapter's behaviour: unique slug, phone and email,
 * `serves` from `type`, the fail-closed consent hook, immutable slug, and org
 * details from the org with the `legacy_org_details` fallback. Org details are
 * seeded per org id (`UserStoreFake.seedOrgDetails`); the Default org is
 * {@link MEMORY_DEFAULT_ORG_ID} unless a test changes it.
 */

import { randomUUID } from 'node:crypto';
import {
  UserStoreBase,
  type Coordinator,
  type CreateCoordinatorInput,
  type ListCoordinatorsFilter,
  type ListCoordinatorsPage,
  type DeleteIfPendingOutcome,
  type OrgCoordinatorCounts,
  type SearchCoordinatorsFilter,
  type SearchCoordinatorsPage,
  type StoreError,
  type StoreResult,
  type LegacyOrgDetails,
  type UpdateCoordinatorPatch,
} from './interface.js';
import type { AggregatorStatus, BecknContact } from '@aggregator-dpg/shared-primitives/aggregator';
import { renderOrgDetails, type OrgDetailColumns } from './org-details.js';
import { servesOf } from './serves.js';

/** The Default org's id in the in-memory store (matches `buildDefaultOrg`). */
export const MEMORY_DEFAULT_ORG_ID = '00000000-0000-0000-0000-0000000000d0';
import { contactId } from '@aggregator-dpg/shared-primitives/contact';

/**
 * The contact id for this email and phone, or `null` when the phone is not canonical.
 * Postgres rejects that write as `CHECK_VIOLATION`.
 */
function safeContactId(email: string, phone: string): string | null {
  try {
    return contactId(email, phone);
  } catch {
    return null;
  }
}

export class InMemoryUserStore extends UserStoreBase {
  protected readonly byId = new Map<string, Coordinator>();
  protected readonly bySlug = new Map<string, string>();
  protected readonly byPhone = new Map<string, string>();
  protected readonly byEmail = new Map<string, string>();

  /** Org-detail columns per org id (seeded by tests). */
  protected readonly orgDetails = new Map<string, OrgDetailColumns>();
  /** Each coordinator's own `legacy_org_details`. */
  protected readonly legacy = new Map<string, LegacyOrgDetails | null>();
  /** Which org id is the Default org. */
  protected defaultOrgId: string = MEMORY_DEFAULT_ORG_ID;
  /** Invite addresses by `jti` (the Postgres store reads them from `registration_invites`). */
  protected readonly inviteEmails = new Map<string, string>();

  /**
   * Renders org details and the composed contact as Postgres does.
   * Company and GST come from the org or legacy values, never the submitted contact.
   */
  private render(
    orgId: string,
    legacy: LegacyOrgDetails | null,
    submitted: BecknContact,
  ): { url: string | null; locations: Coordinator['locations']; contact: BecknContact } {
    const d = renderOrgDetails(this.orgDetails.get(orgId) ?? null, legacy);
    const { name, email, phone, alternatePhone } = submitted;
    return {
      url: d.url,
      locations: d.locations,
      contact: {
        name,
        email,
        phone,
        ...(d.company !== undefined ? { company: d.company } : {}),
        ...(d.gstNumber !== undefined ? { gstNumber: d.gstNumber } : {}),
        ...(alternatePhone !== undefined ? { alternatePhone } : {}),
      },
    };
  }

  /**
   * Re-renders a row's org details on read, as the Postgres join does.
   * Rows with no seeded org details and no legacy values are returned as stored.
   */
  protected view(row: Coordinator): Coordinator {
    const orgId = row.parentOrgId;
    const legacy = this.legacy.get(row.id) ?? null;
    if (!orgId || (!this.orgDetails.has(orgId) && !legacy)) return row;
    const rendered = this.render(orgId, legacy, row.contact);
    return { ...row, url: rendered.url, locations: rendered.locations, contact: rendered.contact };
  }

  /** {@link view} for a possibly-missing row. */
  protected viewOrNull(row: Coordinator | undefined): Coordinator | null {
    return row ? this.view(row) : null;
  }

  async create(input: CreateCoordinatorInput): Promise<StoreResult<Coordinator>> {
    if (this.bySlug.has(input.orgSlug)) {
      return errResult('DUPLICATE_SLUG', `slug already exists: ${input.orgSlug}`);
    }
    const phone = input.contact.phone;
    const email = input.contact.email.toLowerCase();
    if (this.byPhone.has(phone)) {
      return errResult('DUPLICATE_PHONE', `phone already exists: ${phone}`);
    }
    if (this.byEmail.has(email)) {
      return errResult('DUPLICATE_EMAIL', `email already exists: ${email}`);
    }

    const cid = safeContactId(email, phone);
    if (!cid) return errResult('CHECK_VIOLATION', 'contactId: phone must be canonical');

    const id = randomUUID();
    // Nothing is stored when the consent write fails.
    if (input.recordConsent) {
      try {
        await input.recordConsent(undefined, id);
      } catch {
        return errResult('CONSENT_WRITE_FAILED', 'consent could not be recorded');
      }
    }

    const now = new Date();
    this.legacy.set(id, input.legacyOrgDetails ?? null);
    const rendered = this.render(input.orgId, input.legacyOrgDetails ?? null, input.contact);
    const serves = servesOf(input.type);
    const row: Coordinator = {
      id,
      orgSlug: input.orgSlug,
      actorType: 'aggregator',
      name: input.name,
      type: serves[0] ?? null,
      serves,
      url: rendered.url,
      contactId: cid,
      contact: rendered.contact,
      contactPhone: phone,
      contactEmail: email,
      locations: rendered.locations,
      consent: input.consent,
      profile: input.profile ?? {},
      profileRef: input.profileRef ?? null,
      status: 'pending',
      createdBy: input.createdBy,
      updatedBy: input.updatedBy,
      createdAt: now,
      updatedAt: now,
      signalstackOrgId: null,
      parentOrgId: input.orgId,
      isDefaultOrg: input.orgId === this.defaultOrgId,
      inviteEmail: input.inviteId ? (this.inviteEmails.get(input.inviteId) ?? null) : null,
      inviteId: input.inviteId ?? null,
      rejectedAt: null,
    };
    this.indexInsert(row);
    return { ok: true, value: this.view(row) };
  }

  findById(id: string): Promise<StoreResult<Coordinator | null>> {
    return Promise.resolve({ ok: true, value: this.viewOrNull(this.byId.get(id)) });
  }

  findBySlug(orgSlug: string): Promise<StoreResult<Coordinator | null>> {
    const id = this.bySlug.get(orgSlug);
    return Promise.resolve({ ok: true, value: id ? this.viewOrNull(this.byId.get(id)) : null });
  }

  findByContactPhone(phone: string): Promise<StoreResult<Coordinator | null>> {
    const id = this.byPhone.get(phone);
    return Promise.resolve({ ok: true, value: id ? this.viewOrNull(this.byId.get(id)) : null });
  }

  findByContactEmail(email: string): Promise<StoreResult<Coordinator | null>> {
    const id = this.byEmail.get(email.toLowerCase());
    return Promise.resolve({ ok: true, value: id ? this.viewOrNull(this.byId.get(id)) : null });
  }

  findByParentOrgId(orgId: string): Promise<StoreResult<Coordinator[]>> {
    return Promise.resolve({
      ok: true,
      value: [...this.byId.values()]
        .filter((r) => r.parentOrgId === orgId)
        .map((r) => this.view(r)),
    });
  }

  list(filter: ListCoordinatorsFilter): Promise<StoreResult<ListCoordinatorsPage>> {
    const limit = Math.max(1, Math.min(1000, filter.limit ?? 50));
    const offset = Math.max(0, filter.offset ?? 0);
    let rows = [...this.byId.values()];
    if (filter.status) rows = rows.filter((r) => r.status === filter.status);
    if (filter.updatedBefore) {
      const before = filter.updatedBefore.getTime();
      rows = rows.filter((r) => r.updatedAt.getTime() < before);
    }
    rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return Promise.resolve({
      ok: true,
      value: {
        rows: rows.slice(offset, offset + limit).map((r) => this.view(r)),
        total: rows.length,
      },
    });
  }

  update(id: string, patch: UpdateCoordinatorPatch): Promise<StoreResult<Coordinator>> {
    const existing = this.byId.get(id);
    if (!existing) return Promise.resolve(errResult('NOT_FOUND', id));

    let nextPhone = existing.contactPhone;
    let nextEmail = existing.contactEmail;
    let nextContact = existing.contact;
    if (patch.contact) {
      nextContact = existing.parentOrgId
        ? this.render(existing.parentOrgId, this.legacy.get(id) ?? null, patch.contact).contact
        : patch.contact;
      nextPhone = patch.contact.phone;
      nextEmail = patch.contact.email.toLowerCase();
      if (nextPhone !== existing.contactPhone && this.byPhone.has(nextPhone)) {
        return Promise.resolve(errResult('DUPLICATE_PHONE', `phone already exists: ${nextPhone}`));
      }
      if (nextEmail !== existing.contactEmail && this.byEmail.has(nextEmail)) {
        return Promise.resolve(errResult('DUPLICATE_EMAIL', `email already exists: ${nextEmail}`));
      }
    }

    const nextId = safeContactId(nextEmail, nextPhone);
    if (!nextId)
      return Promise.resolve(errResult('CHECK_VIOLATION', 'contactId: phone must be canonical'));

    const next: Coordinator = {
      ...existing,
      name: patch.name ?? existing.name,
      ...(patch.type !== undefined
        ? { serves: servesOf(patch.type), type: servesOf(patch.type)[0] ?? null }
        : {}),
      ...(patch.serves !== undefined
        ? { serves: [...new Set(patch.serves)], type: patch.serves[0] ?? null }
        : {}),
      contactId: nextId,
      contact: nextContact,
      contactPhone: nextPhone,
      contactEmail: nextEmail,
      status: patch.status ?? existing.status,
      rejectedAt: patch.rejectedAt !== undefined ? patch.rejectedAt : existing.rejectedAt,
      updatedBy: patch.updatedBy,
      updatedAt: new Date(),
    };
    this.indexReplace(existing, next);
    return Promise.resolve({ ok: true, value: this.view(next) });
  }

  async updateStatus(
    id: string,
    status: AggregatorStatus,
    updatedBy: string,
  ): Promise<StoreResult<Coordinator>> {
    return this.update(id, { status, updatedBy });
  }

  async approveFromPending(
    id: string,
    updatedBy: string,
  ): Promise<StoreResult<Coordinator | null>> {
    const existing = this.byId.get(id);
    // Only pending → active; anything else means already decided.
    if (!existing || existing.status !== 'pending') return { ok: true, value: null };
    return this.update(id, { status: 'active', updatedBy });
  }

  updateSignalstackOrgId(
    id: string,
    signalstackOrgId: string,
    updatedBy: string,
  ): Promise<StoreResult<Coordinator>> {
    const existing = this.byId.get(id);
    if (!existing) return Promise.resolve(errResult('NOT_FOUND', id));
    const next: Coordinator = {
      ...existing,
      signalstackOrgId,
      updatedBy,
      updatedAt: new Date(),
    };
    this.byId.set(id, next);
    return Promise.resolve({ ok: true, value: this.view(next) });
  }

  deleteById(id: string): Promise<StoreResult<void>> {
    const row = this.byId.get(id);
    if (!row) return Promise.resolve(errResult('NOT_FOUND', id));
    this.byId.delete(id);
    this.bySlug.delete(row.orgSlug);
    this.byPhone.delete(row.contactPhone);
    this.byEmail.delete(row.contactEmail);
    return Promise.resolve({ ok: true, value: undefined });
  }

  async rejectFromPending(id: string, updatedBy: string): Promise<StoreResult<Coordinator | null>> {
    const existing = this.byId.get(id);
    // Only pending → inactive; anything else means already decided.
    if (existing?.status !== 'pending') return { ok: true, value: null };
    return this.update(id, { status: 'inactive', rejectedAt: new Date(), updatedBy });
  }

  async deleteIfPending(
    id: string,
    cutoff: Date,
    beforeCommit: () => Promise<boolean>,
  ): Promise<StoreResult<DeleteIfPendingOutcome>> {
    const row = this.byId.get(id);
    if (row?.status !== 'pending' || (row?.updatedAt.getTime() ?? 0) >= cutoff.getTime()) {
      return { ok: true, value: 'not_pending' };
    }
    if (!(await beforeCommit())) return { ok: true, value: 'aborted' };
    const deleted = await this.deleteById(id);
    return deleted.ok ? { ok: true, value: 'deleted' } : deleted;
  }

  search(filter: SearchCoordinatorsFilter): Promise<StoreResult<SearchCoordinatorsPage>> {
    const limit = Math.max(1, Math.min(100, filter.limit ?? 20));
    let rows = [...this.byId.values()];
    if (filter.orgIds !== null) {
      const scope = new Set(filter.orgIds);
      rows = rows.filter((r) => r.parentOrgId !== null && scope.has(r.parentOrgId));
    }
    if (filter.status) rows = rows.filter((r) => r.status === filter.status);
    if (filter.serves) {
      const d = filter.serves;
      rows = rows.filter((r) => r.serves.length === 0 || r.serves.includes(d));
    }
    // Newest first, id as the tie-break (descending), as Postgres orders.
    rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1));
    if (filter.cursor) {
      const c = filter.cursor;
      rows = rows.filter(
        (r) =>
          r.createdAt.getTime() < c.createdAt.getTime() ||
          (r.createdAt.getTime() === c.createdAt.getTime() && r.id < c.id),
      );
    }
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return Promise.resolve({
      ok: true,
      value: {
        rows: page.map((r) => this.view(r)),
        nextCursor: rows.length > limit && last ? { createdAt: last.createdAt, id: last.id } : null,
      },
    });
  }

  countByOrg(orgIds: string[]): Promise<StoreResult<Record<string, OrgCoordinatorCounts>>> {
    const out: Record<string, OrgCoordinatorCounts> = {};
    for (const id of orgIds) out[id] = { total: 0, pending: 0 };
    for (const r of this.byId.values()) {
      const counts = r.parentOrgId ? out[r.parentOrgId] : undefined;
      if (!counts) continue;
      counts.total += 1;
      if (r.status === 'pending') counts.pending += 1;
    }
    return Promise.resolve({ ok: true, value: out });
  }

  // ─── Index maintenance ────────────────────────────────────────────────────

  protected indexInsert(row: Coordinator): void {
    this.byId.set(row.id, row);
    this.bySlug.set(row.orgSlug, row.id);
    this.byPhone.set(row.contactPhone, row.id);
    this.byEmail.set(row.contactEmail, row.id);
  }

  protected indexReplace(prev: Coordinator, next: Coordinator): void {
    this.byId.set(next.id, next);
    if (prev.contactPhone !== next.contactPhone) {
      this.byPhone.delete(prev.contactPhone);
      this.byPhone.set(next.contactPhone, next.id);
    }
    if (prev.contactEmail !== next.contactEmail) {
      this.byEmail.delete(prev.contactEmail);
      this.byEmail.set(next.contactEmail, next.id);
    }
    // org_slug is immutable.
  }
}

function errResult<T>(code: StoreError['code'], message: string): StoreResult<T> {
  return { ok: false, error: { code, message } as StoreError };
}
