/**
 * In-memory SignalStackWriter — Map-backed, used by unit tests.
 *
 * Mirrors signalstack semantics as closely as a fake can:
 *   - User identity is shared (single row per phone OR email).
 *   - Profile rows are appended; uniqueness is NOT enforced (matches current
 *     server behaviour — no dedupe on items).
 *   - `aggregator_id` is recorded on create and immutable on update.
 *
 * Returned ids and timestamps are deterministic across the lifetime of the
 * writer to make assertions predictable.
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
  type SignalStackDecryptedProfileRow,
  type SignalStackDecryptedProfiles,
  type SignalStackFetchDecryptedProfilesQuery,
  type SignalStackGetItemQuery,
  type SignalStackItemList,
  type SignalStackItemQuery,
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
  /** Acting org id captured at onboard time; mirrored from x-acting-org-id. */
  acting_org_id: string;
  /** Channel attribution captured at onboard time. */
  channel: 'bulk' | 'link';
  /** Source id captured at onboard time (bulk_upload_id or link_id). */
  source_id: string;
}

const ISO_FIXED = '2026-01-01T00:00:00.000Z';

export class InMemorySignalStackWriter extends SignalStackWriterBase {
  protected readonly users: Map<string, StoredUser> = new Map();
  protected readonly profiles: Map<string, StoredProfile> = new Map();
  /**
   * Aggregator org table keyed by `external_id` (our Postgres aggregator
   * UUID). Mirrors signalstack's dedupe key so repeated upserts with the
   * same input return the same `org_id` and never create duplicates.
   */
  protected readonly aggregators: Map<string, SignalStackAggregator> = new Map();
  /**
   * Pinned lifecycle classification used by the next `onboard()` call when
   * `submit_mode !== 'account_only'`. Consumed (cleared) after one use so a
   * second call falls back to the default `live` classification.
   * Tests set this via {@link setNextClassification}.
   */
  protected nextClassification: { lifecycle_status: 'draft' | 'live' | 'paused' } | undefined;
  /**
   * Foreign-user lookup keys (`email:...` / `phone:...`). When the next
   * `onboard()` matches a key here, the writer returns `owned_elsewhere:
   * true` with no item — mirroring signalstack's behaviour when the user
   * already exists under a different aggregator. Tests seed entries via
   * {@link seedForeignUser}.
   */
  protected readonly foreignUsers: Set<string> = new Set();
  /**
   * Own-user probe seeds keyed by `email:...` / `phone:...`. Each entry
   * carries the acting org id and optionally the primary item's
   * lifecycle classification. {@link probeUser} returns
   * `user_exists: true` (with `lifecycle_summary` populated when the
   * entry has an `item`) on a key hit. Tests seed entries via
   * {@link seedOwnUser}. Kept separate from {@link profiles} because
   * probes do not need a full StoredProfile row — only the slim
   * classification triple a lifecycle resumption requires.
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
    // Mirror Signals' hard-reject of under-18 onboards via the admin API
    // (`U18_NOT_ALLOWED`) so callers can exercise the §4.4 redirect mapping.
    if (typeof input.age === 'number' && input.age <= 18) {
      return err(
        new UpstreamError(
          'signalstack onboard returned 400: U18_NOT_ALLOWED: under-18 users cannot be onboarded via this API; use the portal',
          { code: 'SIGNALSTACK_BAD_REQUEST' },
        ),
      );
    }

    // Foreign-user short-circuit: signalstack reports the user already
    // exists under a different aggregator, so we mint a synthetic user_id
    // (signals would echo its own) and surface owned_elsewhere=true with
    // no item. Lifecycle fields are omitted because no item exists for
    // this aggregator.
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

    // account_only: signalstack creates the user row but no item. Lookup
    // endpoint + partial-data registrations use this path to opt out of
    // item creation. No lifecycle fields are returned because no item
    // exists yet.
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
    // Consume the pinned classification so a second call reverts to the
    // default `live` shape — keeps test fixtures terse without forcing every
    // test to reset the writer.
    this.nextClassification = undefined;

    const profile: StoredProfile = {
      item_id: profileItemId,
      item_network: input.network,
      item_domain: input.domain,
      item_type: input.item_type,
      item_state: input.profile,
      item_latitude: null,
      item_longitude: null,
      aggregator_id: null,
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
   * Pins the lifecycle classification used by the next `onboard()` call
   * (when `submit_mode !== 'account_only'`). The classification is
   * consumed after one call — subsequent calls fall back to the default
   * `live` / `100` shape until re-pinned.
   *
   * @param classification - Pinned lifecycle status + completion percent.
   */
  setNextClassification(classification: { lifecycle_status: 'draft' | 'live' | 'paused' }): void {
    this.nextClassification = classification;
  }

  /**
   * Marks the given email and/or phone as belonging to a user that
   * signalstack reports under a different aggregator. The next
   * `onboard()` matching one of these keys returns `owned_elsewhere:
   * true` with no item — mirroring signalstack's response when the user
   * already exists outside the calling aggregator's scope.
   *
   * @param key - Email and/or phone to mark as foreign-owned. At least
   *   one of `email` or `phoneNumber` must be provided.
   */
  seedForeignUser(key: { email?: string; phoneNumber?: string }): void {
    const email = normalizeEmail(key.email);
    const phone = normalizePhone(key.phoneNumber);
    if (email) this.foreignUsers.add(`email:${email}`);
    if (phone) this.foreignUsers.add(`phone:${phone}`);
  }

  /**
   * Registers an own-aggregator user for {@link probeUser} matches.
   * Tests seed an entry per identity (email, phoneNumber, or both) plus
   * an optional `item` carrying the primary lifecycle classification.
   *
   * When the next `probeUser` call matches the email or phone key, the
   * fake returns `user_exists: true`, `owned_elsewhere: false`, and
   * (when `item` is present) a populated `lifecycle_summary`.
   *
   * Re-seeding the same key overwrites the previous entry. At least one
   * of `email` or `phoneNumber` must be supplied.
   *
   * @param seed - actingOrgId + at least one identity + optional item.
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

    // Foreign-owned user takes precedence over an own-user seed for the
    // same identity — signals never returns lifecycle state across
    // aggregator boundaries.
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

  override async getItem(
    query: SignalStackGetItemQuery,
  ): Promise<Result<SignalStackProfile | null, BaseError>> {
    if (!query?.item_id) {
      return err(
        new ValidationError('item_id is required', {
          code: 'SIGNALSTACK_INPUT_INVALID',
        }),
      );
    }
    const row = this.profiles.get(query.item_id);
    if (!row) return ok(null);
    return ok(stripCreatedBy(row));
  }

  /**
   * Seeds a single signalstack item keyed by `itemId`, filling unspecified
   * fields with deterministic defaults. Used by tests to pin the lifecycle
   * a `getItem(...)` lookup will surface for a given id.
   *
   * Re-seeding the same `itemId` overwrites the previous entry.
   *
   * @param itemId - Item id the seed is keyed under.
   * @param partial - Optional overrides; `lifecycle_status` is the field the
   *   lifecycle re-check reads.
   */
  seedItem(
    itemId: string,
    partial: Partial<SignalStackProfile> & {
      lifecycle_status?: 'draft' | 'live' | 'paused';
    } = {},
  ): void {
    const row: StoredProfile = {
      item_id: itemId,
      item_network: partial.item_network ?? 'blue_dot',
      item_domain: partial.item_domain ?? 'seeker',
      item_type: partial.item_type ?? 'profile_1.0',
      item_state: partial.item_state ?? {},
      item_latitude: partial.item_latitude ?? null,
      item_longitude: partial.item_longitude ?? null,
      aggregator_id: partial.aggregator_id ?? null,
      created_at: partial.created_at ?? ISO_FIXED,
      updated_at: partial.updated_at ?? ISO_FIXED,
      ...(partial.lifecycle_status !== undefined
        ? { lifecycle_status: partial.lifecycle_status }
        : {}),
      created_by: '',
      acting_org_id: '',
      channel: 'link',
      source_id: '',
    };
    this.profiles.set(itemId, row);
  }

  override async listItemsByAggregator(
    query: SignalStackItemQuery,
  ): Promise<Result<SignalStackItemList, BaseError>> {
    if (!query.aggregator_id || !query.item_network || !query.item_domain) {
      return err(
        new UpstreamError('aggregator_id, item_network, and item_domain are required', {
          code: 'SIGNALSTACK_INPUT_INVALID',
        }),
      );
    }
    // signalstack's default is `live_only` — drafts and paused rows are
    // hidden unless the caller passes `lifecycle_filter: 'all'`. Treat an
    // absent lifecycle_status on a stored row as 'live' so seeds written
    // before lifecycle support landed remain visible by default.
    const lifecycleFilter: 'live_only' | 'all' = query.lifecycle_filter ?? 'live_only';
    const matching = Array.from(this.profiles.values()).filter((p) => {
      if (p.aggregator_id !== query.aggregator_id) return false;
      if (p.item_network !== query.item_network) return false;
      if (p.item_domain !== query.item_domain) return false;
      if (query.item_type && p.item_type !== query.item_type) return false;
      if (lifecycleFilter === 'live_only') {
        const status = p.lifecycle_status ?? 'live';
        if (status !== 'live') return false;
      }
      return true;
    });
    const total = matching.length;
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 50;
    const page = matching.slice(offset, offset + limit).map(stripCreatedBy);
    return ok({ meta: { total, limit, offset }, items: page });
  }

  /**
   * Deterministic Map-backed upsert. First call for an `external_id`
   * mints a new `mem-org-N` id and stores the row; subsequent calls update
   * `name`, `slug`, and `metadata` in place and return the same `org_id`.
   * Used by unit + cross-package consumer tests to assert against the
   * aggregator-approval flow without touching a real signalstack.
   *
   * @param input - external_id (our aggregator UUID) + display name + slug
   *   + optional metadata bag.
   * @returns ok(SignalStackAggregator) — same id on repeat calls;
   *   err(BaseError) only when a required input field is missing.
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

  /** Test helper — current user table snapshot. */
  listUsers(): StoredUser[] {
    return Array.from(this.users.values());
  }

  /** Test helper — current profile table snapshot. */
  listProfiles(): StoredProfile[] {
    return Array.from(this.profiles.values());
  }

  /**
   * Snapshot of the in-memory aggregator table. Tests use this to assert
   * which upserts the approval flow dispatched without depending on the
   * fake's internal Map.
   *
   * @returns Array of stored aggregator rows in insertion order.
   */
  listAggregators(): SignalStackAggregator[] {
    return Array.from(this.aggregators.values());
  }

  /**
   * Pinned dashboard responses keyed by `actingOrgId`. Test helpers may
   * write directly via `seed({ dashboards })` on the testing fake; when
   * unset, {@link fetchDashboard} synthesises a deterministic empty
   * rollup so callers that only care about the success path still get a
   * usable shape.
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
   * Pinned CSV exports keyed by `actingOrgId`. Tests that exercise the
   * export route MUST seed a row here — the fake does not synthesise a
   * CSV body because signalstack owns the column set and that shape
   * changes over time. Unseeded callers get an empty body and a
   * `SIGNALSTACK_BAD_RESPONSE` error so the test fails loud instead of
   * passing on a stale hardcoded header list.
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
        profiles.push({
          item_id: stored.item_id,
          item_network: stored.item_network,
          item_domain: stored.item_domain,
          item_type: stored.item_type,
          item_state: stored.item_state,
          created_at: stored.created_at,
          updated_at: stored.updated_at,
        });
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

function stripCreatedBy(profile: StoredProfile): SignalStackProfile {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { created_by, acting_org_id, channel, source_id, ...rest } = profile;
  return rest;
}

/**
 * Deterministic empty per-domain slice. The synthesised dashboard payload
 * from {@link InMemorySignalStackWriter.fetchDashboard} uses this for every
 * domain when the test hasn't pinned a response — the shape mirrors the
 * live signalstack contract so downstream consumers never branch on
 * "shape from real api vs. fake".
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
