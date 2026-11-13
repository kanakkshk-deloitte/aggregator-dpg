/**
 * Map-backed SignalStackWriter for unit tests, in the signalstack-writer package.
 *
 * Follows signalstack behaviour:
 *   - One user row per phone or email.
 *   - Profile rows are appended; items are not deduplicated.
 *
 * Returned ids and timestamps are deterministic.
 */

import { UpstreamError, ValidationError } from '@aggregator-dpg/shared-primitives/errors';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import { err, ok } from '@aggregator-dpg/shared-primitives/result';
import type { Result } from '@aggregator-dpg/shared-primitives/result';

import {
  SignalStackWriterBase,
  type SignalStackAggregator,
  type SignalStackDashboardExport,
  type SignalStackDashboardExportQuery,
  type SignalStackDashboardPage,
  type SignalStackDashboardQuery,
  type SignalStackContactCanonical,
  type SignalStackContactValue,
  type SignalStackDecryptedProfileRow,
  type SignalStackDecryptedProfiles,
  type SignalStackFetchDecryptedProfilesQuery,
  type SignalStackOnboardParticipantInput,
  type SignalStackOnboardParticipantResult,
  type SignalStackProbeUserInput,
  type SignalStackProbeUserResult,
  type SignalStackProfile,
  type SignalStackUpsertAggregatorInput,
} from './interface.js';

interface StoredUser {
  id: string;
  name: string;
  email: string | null;
  phoneNumber: string | null;
  role: string | null;
}

interface StoredProfile extends SignalStackProfile {
  created_by: string;
  /** Acting org id (x-acting-org-id) from the onboard call. */
  acting_org_id: string;
  /** Channel from the onboard call. */
  channel: 'bulk' | 'link';
  /** Source id from the onboard call (bulk_upload_id or link_id). */
  source_id: string;
  /** Contact block returned when decrypt requests `contact`. Set by test seeds. */
  contact?: Partial<Record<SignalStackContactCanonical, SignalStackContactValue>>;
}

const ISO_FIXED = '2026-01-01T00:00:00.000Z';

export class InMemorySignalStackWriter extends SignalStackWriterBase {
  protected readonly users: Map<string, StoredUser> = new Map();
  protected readonly profiles: Map<string, StoredProfile> = new Map();
  /**
   * Aggregator orgs keyed by `external_id` (our aggregator UUID). Repeated
   * upserts return the same `org_id`.
   */
  protected readonly aggregators: Map<string, SignalStackAggregator> = new Map();
  /**
   * Lifecycle status for the next item-creating `onboard()` call. Cleared after
   * one use. Set via {@link setNextClassification}.
   */
  protected nextClassification: { lifecycle_status: 'draft' | 'live' | 'paused' } | undefined;
  /**
   * Keys (`email:...` / `phone:...`) of users owned by another aggregator.
   * A matching `onboard()` returns `owned_elsewhere: true` with no item. Set
   * via {@link seedForeignUser}.
   */
  protected readonly foreignUsers: Set<string> = new Set();
  /**
   * Own-user probe entries keyed by `email:...` / `phone:...`. On a match,
   * {@link probeUser} returns `user_exists: true`, with `lifecycle_summary`
   * set when the entry has an `item`. Set via {@link seedOwnUser}.
   */
  protected readonly ownUserProbes: Map<
    string,
    {
      actingOrgId: string;
      email: string | null;
      phoneNumber: string | null;
      item?: {
        item_id: string;
        lifecycle_status: 'draft' | 'live' | 'paused';
      };
    }
  > = new Map();
  private nextUserSeq = 1;
  private nextProfileSeq = 1;
  private nextAggregatorSeq = 1;

  override async onboard(
    input: SignalStackOnboardParticipantInput,
  ): Promise<Result<SignalStackOnboardParticipantResult, BaseError>> {
    if (!input?.actingOrgId) {
      return err(
        new UpstreamError('actingOrgId is required', { code: 'SIGNALSTACK_INPUT_INVALID' }),
      );
    }
    if (!input.name) {
      return err(new UpstreamError('name is required', { code: 'SIGNALSTACK_INPUT_INVALID' }));
    }
    const email = normalizeEmail(input.email);
    const phone = normalizePhone(input.phoneNumber);
    if (!email && !phone) {
      return err(
        new UpstreamError('either email or phoneNumber is required', {
          code: 'SIGNALSTACK_INPUT_INVALID',
        }),
      );
    }
    if (!input.channel || !input.source_id) {
      return err(
        new UpstreamError('channel and source_id are required', {
          code: 'SIGNALSTACK_INPUT_INVALID',
        }),
      );
    }
    // Signals rejects under-18 onboards via the admin API with `U18_NOT_ALLOWED`.
    if (typeof input.age === 'number' && input.age <= 18) {
      return err(
        new UpstreamError(
          'signalstack onboard returned 400: U18_NOT_ALLOWED: under-18 users cannot be onboarded via this API; use the portal',
          { code: 'SIGNALSTACK_BAD_REQUEST' },
        ),
      );
    }

    // User owned by another aggregator: return owned_elsewhere with no item.
    const foreignEmailKey = email ? `email:${email}` : null;
    const foreignPhoneKey = phone ? `phone:${phone}` : null;
    const isForeign =
      (foreignEmailKey !== null && this.foreignUsers.has(foreignEmailKey)) ||
      (foreignPhoneKey !== null && this.foreignUsers.has(foreignPhoneKey));
    if (isForeign) {
      const foreignUserId = `mem-foreign-user-${this.nextUserSeq++}`;
      return ok({
        user_id: foreignUserId,
        profile_item_id: '',
        onboarded_at: ISO_FIXED,
        already_registered: true,
        owned_elsewhere: true,
      });
    }

    const emailUser = email ? this.findByEmail(email) : undefined;
    const phoneUser = phone ? this.findByPhone(phone) : undefined;
    if (emailUser && phoneUser && emailUser.id !== phoneUser.id) {
      return err(
        new UpstreamError('email and phoneNumber map to different existing users', {
          code: 'SIGNALSTACK_CONFLICT',
        }),
      );
    }

    let userRow = emailUser ?? phoneUser;
    if (!userRow) {
      userRow = {
        id: `mem-user-${this.nextUserSeq++}`,
        name: input.name,
        email,
        phoneNumber: phone,
        role: 'user',
      };
      this.users.set(userRow.id, userRow);
    }

    // account_only: user row only, no item, so no lifecycle fields.
    const submitMode: 'with_item' | 'account_only' = input.submit_mode ?? 'with_item';
    if (submitMode === 'account_only') {
      return ok({
        user_id: userRow.id,
        profile_item_id: '',
        onboarded_at: ISO_FIXED,
        owned_elsewhere: false,
      });
    }

    const profileItemId = `mem-item-${this.nextProfileSeq++}`;
    const classification = this.nextClassification ?? { lifecycle_status: 'live' as const };
    this.nextClassification = undefined;

    const profile: StoredProfile = {
      item_id: profileItemId,
      item_network: input.network,
      item_domain: input.domain,
      item_type: input.item_type,
      item_state: input.profile,
      item_latitude: null,
      item_longitude: null,
      created_at: ISO_FIXED,
      updated_at: ISO_FIXED,
      lifecycle_status: classification.lifecycle_status,
      created_by: userRow.id,
      acting_org_id: input.actingOrgId,
      channel: input.channel,
      source_id: input.source_id,
    };
    this.profiles.set(profileItemId, profile);

    return ok({
      user_id: userRow.id,
      profile_item_id: profileItemId,
      onboarded_at: ISO_FIXED,
      lifecycle_status: classification.lifecycle_status,
      owned_elsewhere: false,
    });
  }

  /**
   * Sets the lifecycle status for the next item-creating `onboard()` call.
   * Later calls use `live` until set again.
   *
   * @param classification - Lifecycle status to return.
   */
  setNextClassification(classification: { lifecycle_status: 'draft' | 'live' | 'paused' }): void {
    this.nextClassification = classification;
  }

  /**
   * Marks an email and/or phone as owned by another aggregator.
   *
   * Matching `onboard()` and `probeUser()` calls return `owned_elsewhere: true`.
   *
   * @param key - Email and/or phone; at least one is required.
   */
  seedForeignUser(key: { email?: string; phoneNumber?: string }): void {
    const email = normalizeEmail(key.email);
    const phone = normalizePhone(key.phoneNumber);
    if (email) this.foreignUsers.add(`email:${email}`);
    if (phone) this.foreignUsers.add(`phone:${phone}`);
  }

  /**
   * Registers a user of this aggregator for {@link probeUser}.
   *
   * A matching probe returns `user_exists: true`, `owned_elsewhere: false`,
   * and a `lifecycle_summary` when `item` is set. Seeding the same key again
   * overwrites the entry.
   *
   * @param seed - actingOrgId, at least one of email/phoneNumber, and an optional item.
   */
  seedOwnUser(seed: {
    actingOrgId: string;
    email?: string;
    phoneNumber?: string;
    item?: {
      item_id: string;
      lifecycle_status: 'draft' | 'live' | 'paused';
    };
  }): void {
    const email = normalizeEmail(seed.email);
    const phone = normalizePhone(seed.phoneNumber);
    const entry = {
      actingOrgId: seed.actingOrgId,
      email,
      phoneNumber: phone,
      ...(seed.item ? { item: seed.item } : {}),
    };
    if (email) this.ownUserProbes.set(`email:${email}`, entry);
    if (phone) this.ownUserProbes.set(`phone:${phone}`, entry);
  }

  override async probeUser(
    input: SignalStackProbeUserInput,
  ): Promise<Result<SignalStackProbeUserResult, BaseError>> {
    if (!input?.actingOrgId) {
      return err(
        new ValidationError('actingOrgId is required', {
          code: 'SIGNALSTACK_INPUT_INVALID',
        }),
      );
    }
    const email = normalizeEmail(input.email);
    const phone = normalizePhone(input.phoneNumber);
    if (!email && !phone) {
      return err(
        new ValidationError('email or phoneNumber required', {
          code: 'SIGNALSTACK_INPUT_INVALID',
        }),
      );
    }
    if (!input.network || !input.domain) {
      return err(
        new ValidationError('network and domain are required', {
          code: 'SIGNALSTACK_INPUT_INVALID',
        }),
      );
    }

    // A foreign-owned match wins over an own-user seed for the same identity.
    const emailKey = email ? `email:${email}` : null;
    const phoneKey = phone ? `phone:${phone}` : null;
    const isForeign =
      (emailKey !== null && this.foreignUsers.has(emailKey)) ||
      (phoneKey !== null && this.foreignUsers.has(phoneKey));
    if (isForeign) {
      return ok({
        user_exists: true,
        owned_elsewhere: true,
        lifecycle_summary: null,
      });
    }

    const ownEntry =
      (emailKey ? this.ownUserProbes.get(emailKey) : undefined) ??
      (phoneKey ? this.ownUserProbes.get(phoneKey) : undefined);
    if (ownEntry) {
      if (ownEntry.item) {
        return ok({
          user_exists: true,
          owned_elsewhere: false,
          lifecycle_summary: {
            primary_item: {
              item_id: ownEntry.item.item_id,
              lifecycle_status: ownEntry.item.lifecycle_status,
            },
          },
        });
      }
      return ok({
        user_exists: true,
        owned_elsewhere: false,
        lifecycle_summary: null,
      });
    }

    return ok({
      user_exists: false,
      owned_elsewhere: false,
      lifecycle_summary: null,
    });
  }

  /**
   * Creates or updates an aggregator row keyed by `external_id`.
   *
   * The first call assigns `mem-org-N`. Later calls update `name`, `slug`, and
   * `metadata` and return the same `org_id`.
   *
   * @param input - external_id, display name, slug, and optional metadata.
   * @returns ok(SignalStackAggregator); err(BaseError) when a required field is missing.
   */
  override async upsertAggregator(
    input: SignalStackUpsertAggregatorInput,
  ): Promise<Result<SignalStackAggregator, BaseError>> {
    if (!input?.external_id || !input?.name || !input?.slug) {
      return err(
        new UpstreamError('external_id, name, and slug are required', {
          code: 'SIGNALSTACK_INPUT_INVALID',
        }),
      );
    }
    const existing = this.aggregators.get(input.external_id);
    if (existing) {
      const updated: SignalStackAggregator = {
        ...existing,
        name: input.name,
        slug: input.slug,
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      };
      this.aggregators.set(input.external_id, updated);
      return ok(updated);
    }
    const row: SignalStackAggregator = {
      org_id: `mem-org-${this.nextAggregatorSeq++}`,
      external_id: input.external_id,
      name: input.name,
      slug: input.slug,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    };
    this.aggregators.set(input.external_id, row);
    return ok(row);
  }

  /** Test helper. Returns all stored users. */
  listUsers(): StoredUser[] {
    return Array.from(this.users.values());
  }

  /** Test helper. Returns all stored profiles. */
  listProfiles(): StoredProfile[] {
    return Array.from(this.profiles.values());
  }

  /**
   * Test helper. Returns all stored aggregator rows.
   *
   * @returns Array of stored aggregator rows in insertion order.
   */
  listAggregators(): SignalStackAggregator[] {
    return Array.from(this.aggregators.values());
  }

  /**
   * Dashboard responses keyed by `actingOrgId`, set via `seed({ dashboards })`.
   * When unset, {@link fetchDashboard} returns an empty rollup.
   */
  protected readonly dashboards: Map<string, SignalStackDashboardPage> = new Map();

  override async fetchDashboard(
    query: SignalStackDashboardQuery,
  ): Promise<Result<SignalStackDashboardPage, BaseError>> {
    if (!query?.actingOrgId) {
      return err(
        new UpstreamError('actingOrgId is required', { code: 'SIGNALSTACK_INPUT_INVALID' }),
      );
    }
    const pinned = this.dashboards.get(query.actingOrgId);
    if (pinned) return ok(pinned);
    return ok({
      by_domain: {
        seeker: emptyDomainSlice(),
        provider: emptyDomainSlice(),
      },
      metadata: {
        last_computed_at: ISO_FIXED,
        ttl_seconds: 3600,
        refreshed: true,
      },
    });
  }

  /**
   * CSV exports keyed by `actingOrgId`. Tests of the export must seed one;
   * signalstack owns the columns, so the fake does not build a CSV. Unseeded
   * calls return `SIGNALSTACK_BAD_RESPONSE`.
   */
  protected readonly dashboardExports: Map<string, string> = new Map();

  override async exportDashboardCsv(
    query: SignalStackDashboardExportQuery,
  ): Promise<Result<SignalStackDashboardExport, BaseError>> {
    if (!query?.actingOrgId) {
      return err(
        new UpstreamError('actingOrgId is required', { code: 'SIGNALSTACK_INPUT_INVALID' }),
      );
    }
    const pinned = this.dashboardExports.get(query.actingOrgId);
    if (!pinned) {
      return err(
        new UpstreamError('signalstack dashboard export returned empty body', {
          code: 'SIGNALSTACK_BAD_RESPONSE',
        }),
      );
    }
    const sanitised = (query.status ?? 'all').replace(/[^a-z0-9_]/gi, '_').slice(0, 32);
    return ok({
      csv: pinned,
      filename: `aggregator-dashboard-${sanitised}-${ISO_FIXED.slice(0, 10)}.csv`,
    });
  }

  override async fetchDecryptedProfiles(
    query: SignalStackFetchDecryptedProfilesQuery,
  ): Promise<Result<SignalStackDecryptedProfiles, BaseError>> {
    if (!query?.actingOrgId) {
      return err(
        new ValidationError('actingOrgId is required', { code: 'SIGNALSTACK_INPUT_INVALID' }),
      );
    }
    if (!Array.isArray(query.itemIds) || query.itemIds.length === 0) {
      return err(
        new ValidationError('itemIds must be a non-empty array', {
          code: 'SIGNALSTACK_INPUT_INVALID',
        }),
      );
    }

    const requested = Array.from(new Set(query.itemIds));
    const profiles: SignalStackDecryptedProfileRow[] = [];
    const skipped: string[] = [];

    for (const id of requested) {
      const stored = this.profiles.get(id);
      if (stored && stored.acting_org_id === query.actingOrgId) {
        // Apply `fields` and `contact` the same way as the HTTP implementation.
        const row: SignalStackDecryptedProfileRow = {
          item_id: stored.item_id,
          item_network: stored.item_network,
          item_domain: stored.item_domain,
          item_type: stored.item_type,
          item_state: projectItemState(stored.item_state, query.fields),
          created_at: stored.created_at,
          updated_at: stored.updated_at,
        };
        if (query.contact) {
          row.contact = resolveContactBlock(stored.contact, query.contact);
        }
        profiles.push(row);
      } else {
        skipped.push(id);
      }
    }

    return ok({ profiles, skipped });
  }

  protected findByEmail(email: string): StoredUser | undefined {
    for (const u of this.users.values()) {
      if (u.email === email) return u;
    }
    return undefined;
  }

  protected findByPhone(phone: string): StoredUser | undefined {
    for (const u of this.users.values()) {
      if (u.phoneNumber === phone) return u;
    }
    return undefined;
  }
}

function normalizeEmail(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed || null;
}

function normalizePhone(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/**
 * Projects a stored item_state to the requested `fields`.
 *
 * `undefined` returns the full state; `[]` returns an empty object; a list
 * keeps only the keys that are present.
 *
 * @param state - The stored item_state.
 * @param fields - Requested field names, or undefined for the full state.
 * @returns The projected item_state.
 */
function projectItemState(
  state: Record<string, unknown>,
  fields: string[] | undefined,
): Record<string, unknown> {
  if (fields === undefined) return state;
  const out: Record<string, unknown> = {};
  for (const key of fields) {
    if (Object.hasOwn(state, key)) out[key] = state[key];
  }
  return out;
}

/**
 * Builds the contact block for the requested fields.
 *
 * `contact: true` resolves all three fields; an array resolves only those.
 * Unseeded fields resolve to `{ value: null, source: null }`.
 *
 * @param seeded - The stored contact block (from the seed), if any.
 * @param contact - The decrypt query's `contact` selector.
 * @returns The resolved contact block.
 */
function resolveContactBlock(
  seeded: Partial<Record<SignalStackContactCanonical, SignalStackContactValue>> | undefined,
  contact: boolean | SignalStackContactCanonical[],
): Partial<Record<SignalStackContactCanonical, SignalStackContactValue>> {
  const canonical: SignalStackContactCanonical[] = Array.isArray(contact)
    ? contact
    : ['name', 'email', 'phone'];
  const out: Partial<Record<SignalStackContactCanonical, SignalStackContactValue>> = {};
  for (const field of canonical) {
    out[field] = seeded?.[field] ?? { value: null, source: null };
  }
  return out;
}

/**
 * Empty per-domain slice in the signalstack response shape.
 *
 * Used by {@link InMemorySignalStackWriter.fetchDashboard} when no response is seeded.
 */
function emptyDomainSlice(): {
  rollup: {
    total_items: number;
    complete_profiles: number;
    has_applications: number;
    by_status: Record<string, number>;
    by_initiated_action_status: Record<string, number>;
    by_received_action_status: Record<string, number>;
    total_users: number;
    avg_items_per_user: number;
    avg_actions_per_user: number;
    mode_wise_counts: Record<string, number>;
  };
  items: Array<Record<string, unknown>>;
  total_matching: number;
  next_cursor: string | null;
} {
  return {
    rollup: {
      total_items: 0,
      complete_profiles: 0,
      has_applications: 0,
      by_status: { new: 0, active: 0, at_risk: 0, inactive: 0 },
      by_initiated_action_status: { create: 0, accept: 0, reject: 0, cancel: 0 },
      by_received_action_status: { create: 0, accept: 0, reject: 0, cancel: 0 },
      total_users: 0,
      avg_items_per_user: 0,
      avg_actions_per_user: 0,
      mode_wise_counts: {},
    },
    items: [],
    total_matching: 0,
    next_cursor: null,
  };
}
