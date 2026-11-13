/**
 * SignalStack writer contract for the signalstack-writer package.
 *
 * Every aggregator path that writes a participant, profile, or aggregator org
 * to signalstack goes through this contract.
 *
 * Every method returns Result<T, BaseError> and never throws.
 */

import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import type { Result } from '@aggregator-dpg/shared-primitives/result';

/**
 * Channel that produced a participant onboard call.
 *   - `bulk` — CSV upload; `source_id` is the `bulk_uploads.id` row.
 *   - `link` — registration link submission; `source_id` is the
 *      `registration_links.id` row.
 */
export type SignalStackOnboardChannel = 'bulk' | 'link';

/**
 * One profile row from signalstack's `items` table, as returned by the
 * dashboard read endpoints.
 */
export interface SignalStackProfile {
  item_id: string;
  item_network: string;
  item_domain: string;
  item_type: string;
  item_state: Record<string, unknown>;
  item_latitude: number | null;
  item_longitude: number | null;
  created_at: string;
  updated_at: string;
  /**
   * Lifecycle status of the item. Older signalstack versions omit it; treat
   * an absent value as `'live'`.
   */
  lifecycle_status?: 'draft' | 'live' | 'paused';
}

/** One participant compliance point forwarded to Signals `/admin/participant`. */
export interface ComplianceEntry {
  /** Compliance point key, e.g. `user_terms`, `user_privacy`, `profile_creation`. */
  key: string;
  /** Accept-only: `false` makes Signals reject with `CONSENT_DECLINED`. */
  value: boolean;
}

/**
 * Input for one participant onboard call to `POST /api/v1/admin/participant`.
 *
 * `actingOrgId` is sent as the `x-acting-org-id` header. It is the
 * aggregator's own signalstack org id (`users.signalstack_org_id`),
 * not the platform-wide acting org id used by aggregator upsert.
 */
export interface SignalStackOnboardParticipantInput {
  /** Correlation id (the x-request-id header) forwarded to Signals for tracing. */
  requestId?: string;
  /** Signalstack organisation id the participant is being linked under. */
  actingOrgId: string;
  /** Display name of the participant; falls back to participant UUID upstream. */
  name: string;
  /** Phone number (E.164). At least one of phoneNumber / email is required. */
  phoneNumber?: string;
  /** Email address. At least one of phoneNumber / email is required. */
  email?: string;
  /**
   * @deprecated Signals ignores this. Consent is recorded only via
   * {@link SignalStackOnboardParticipantInput.compliance}. Never sent.
   */
  terms_accepted?: boolean;
  /** @deprecated See {@link SignalStackOnboardParticipantInput.terms_accepted}. */
  privacy_accepted?: boolean;
  /**
   * Compliance points Signals records for the participant. Any `value: false`
   * makes Signals return `CONSENT_DECLINED`. `user_terms` and `user_privacy`
   * must be sent together, and on a guardian-gated domain they need
   * {@link age}. Absent or empty means no consent is recorded.
   */
  compliance?: ComplianceEntry[];
  /**
   * Participant age. Required by Signals when recording `user_terms`/
   * `user_privacy` on a guardian-gated domain.
   */
  age?: number;
  /** Channel that produced the call: bulk upload or link submission. */
  channel: SignalStackOnboardChannel;
  /**
   * Originating row id: `bulk_uploads.id` for `bulk`, `registration_links.id`
   * for `link`. Signalstack stores it for audit and dedupe.
   */
  source_id: string;
  /** Network the row is stored under, e.g. `blue_dot`. */
  network: string;
  /** Participant domain, e.g. `seeker` or `provider`. */
  domain: string;
  /** Schema version tag, e.g. `profile_1.0` (seeker) or `job_posting_1.0` (provider). */
  item_type: string;
  /** The participant's profile fields, stored as item_state. */
  profile: Record<string, unknown>;
  /**
   * Coordinates the caller already resolved, e.g. from address autocomplete.
   *
   * Omit or pass an empty array to let signalstack geocode the address in
   * `profile`. A non-empty array is stored as-is. Signalstack jitters the
   * point of a `private` location field, so an exact coordinate here is not
   * stored exactly.
   *
   * `lat`/`lng` must be numbers; signalstack rejects strings. `label` allows
   * `undefined` explicitly so Zod `.optional()` output fits under
   * `exactOptionalPropertyTypes`.
   */
  item_locations?: Array<{ lat: number; lng: number; label?: string | undefined }>;
  /**
   * Selects what signals creates:
   *   - `'with_item'` (default) — user plus profile item; signals marks the
   *     item draft or live based on completeness.
   *   - `'account_only'` — user row only; no item_state is sent.
   */
  submit_mode?: 'with_item' | 'account_only';
}

/**
 * Response from `POST /api/v1/admin/participant`.
 *
 * Holds only the ids signalstack created and the server timestamp. Use
 * `fetchDecryptedProfiles` to read the full row.
 */
export interface SignalStackOnboardParticipantResult {
  user_id: string;
  profile_item_id: string;
  onboarded_at: string;
  /**
   * True when the user already exists under a different aggregator. No item
   * is created or returned, so `profile_item_id` is empty. Callers treat this
   * as `skipped`, not an error.
   */
  already_registered?: boolean;
  /** Present only when an item was created (`submit_mode === 'with_item'`). */
  lifecycle_status?: 'draft' | 'live' | 'paused';
  /**
   * Same meaning as {@link already_registered}; both are set. `true` when the
   * user belongs to a different aggregator and no item is returned.
   */
  owned_elsewhere?: boolean;
}

/**
 * Input for the admin aggregator upsert call.
 *
 * `external_id` is the coordinator's `users.id` and is the dedupe key. Repeating the
 * call with the same `external_id` returns the existing row, so it is safe
 * to retry.
 */
export interface SignalStackUpsertAggregatorInput {
  /** Correlation id (the x-request-id header) forwarded to Signals for tracing. */
  requestId?: string;
  external_id: string;
  name: string;
  slug: string;
  /**
   * Signalstack domain ids this aggregator org serves (`seeker`, `provider`, …).
   * The dashboard returns `NO_DOMAINS_CONFIGURED` when this is empty. Pass
   * every domain of the active network.
   */
  domains?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * The signalstack `aggregators` row returned by the upsert call.
 *
 * `org_id` is the signalstack organisation id. The API stores it on the
 * Keycloak user as `signalstack_org_id`, and it appears as a token claim of
 * the same name.
 */
export interface SignalStackAggregator {
  org_id: string;
  external_id: string;
  name: string;
  slug: string;
  metadata?: Record<string, unknown>;
}

/**
 * Query parameters for the aggregator dashboard read.
 *
 * `actingOrgId` is sent as the `x-acting-org-id` header. `status` is
 * forwarded as-is; signalstack defines the allowed values. `domain` is not
 * sent; signalstack scopes by aggregator only.
 */
export interface SignalStackDashboardQuery {
  /** Correlation id (the x-request-id header) forwarded to Signals for tracing. */
  requestId?: string;
  actingOrgId: string;
  page?: number;
  limit?: number;
  status?: string;
  domain?: string;
  /**
   * Lifecycle statuses to include (`draft` | `live` | `paused` | `retired`),
   * sent as a comma-separated `?lifecycle=` filter. Absent uses the Signals
   * default.
   */
  lifecycle?: readonly string[];
  /** When true, sends `?refresh=true` so signalstack skips its cache. Off by default. */
  refresh?: boolean;
}

/**
 * Participant and action counts for one domain.
 *
 * Signalstack may omit zero-count buckets in the partial maps; treat missing
 * keys as 0. `mode_wise_counts` has one key per `onboarded_via` value.
 */
export interface SignalStackDashboardRollup {
  total_items: number;
  complete_profiles: number;
  has_applications: number;
  by_status: Partial<Record<'new' | 'active' | 'at_risk' | 'inactive', number>>;
  /** Actions this domain's profiles initiated, by action state. */
  by_initiated_action_status: Partial<Record<'create' | 'accept' | 'reject' | 'cancel', number>>;
  /** Actions this domain's profiles received, by action state. */
  by_received_action_status: Partial<Record<'create' | 'accept' | 'reject' | 'cancel', number>>;
  /** Distinct users (one user may own many profiles). */
  total_users: number;
  avg_items_per_user: number;
  avg_actions_per_user: number;
  mode_wise_counts: Record<string, number>;
}

/** Rollup and paginated items for one domain of the dashboard response. */
export interface SignalStackDashboardDomainSlice {
  rollup: SignalStackDashboardRollup;
  /**
   * One row per profile. Signalstack owns the row shape. Known keys include
   * profile_item_id, user_id, name, item_network, item_type, onboarded_via,
   * profile_status, profile_completion_pct, profile_created_at,
   * profile_last_updated_at, age_days, initiated, received,
   * last_initiated_at, last_received_at, actionable_tags. `initiated` /
   * `received` are full `{create,accept,reject,cancel}` count maps;
   * `last_initiated_at` / `last_received_at` only hold buckets that occurred.
   */
  items: Array<Record<string, unknown>>;
  total_matching: number;
  next_cursor: string | null;
}

/**
 * Cache metadata for the rollup. `refreshed` is true when signalstack just
 * recomputed, false when it came from cache within `ttl_seconds`.
 */
export interface SignalStackDashboardMetadata {
  last_computed_at: string;
  ttl_seconds: number;
  refreshed: boolean;
}

/**
 * Response from `GET /api/v1/aggregator/dashboard`.
 *
 * Holds every served domain (seeker, provider, …) keyed by domain id.
 */
export interface SignalStackDashboardPage {
  by_domain: Record<string, SignalStackDashboardDomainSlice>;
  metadata: SignalStackDashboardMetadata;
}

/**
 * Query parameters for the dashboard CSV export.
 *
 * `actingOrgId` works as in the dashboard read. `status` is the only filter
 * signalstack accepts; `domain` is not sent.
 */
export interface SignalStackDashboardExportQuery {
  /** Correlation id (the x-request-id header) forwarded to Signals for tracing. */
  requestId?: string;
  actingOrgId: string;
  status?: string;
  domain?: string;
  /** When true, signalstack skips its cache and recomputes. */
  refresh?: boolean;
}

/**
 * Result of the dashboard CSV export.
 *
 * `csv` is the raw `text/csv; charset=utf-8` body from signalstack, returned
 * unchanged. `filename` is a default built from the status filter and date;
 * the route may override it.
 */
export interface SignalStackDashboardExport {
  csv: string;
  filename: string;
}

/**
 * Input for `POST /api/v1/admin/participant/decrypt`.
 *
 * `actingOrgId` is the aggregator's signalstack org id, sent as the
 * `x-acting-org-id` header. Signalstack only decrypts items this aggregator
 * onboarded.
 */
export interface SignalStackFetchDecryptedProfilesQuery {
  /** Correlation id (the x-request-id header) forwarded to Signals for tracing. */
  requestId?: string;
  actingOrgId: string;
  itemIds: string[];
  /**
   * `item_state` field projection, sent as `fields`. `[]` returns an empty
   * `item_state`; omit for the full `item_state`.
   */
  fields?: string[];
  /**
   * Contact fields to resolve with provenance. `true` means all three; an
   * array selects a subset. When set, each row has a `contact` block.
   */
  contact?: boolean | SignalStackContactCanonical[];
}

/** Canonical contact fields resolved by Signals decrypt. */
export type SignalStackContactCanonical = 'name' | 'email' | 'phone';

/**
 * One contact value with its source: `item` (the profile), `user` (the
 * account), or `null` (found in neither; `value` is then `null`).
 */
export interface SignalStackContactValue {
  value: string | null;
  source: 'item' | 'user' | null;
}

/**
 * One decrypted profile row. `item_state` is the cleartext profile; it is
 * empty when `fields: []` was requested. item_private_state is never
 * returned. `contact` is present only when requested.
 */
export interface SignalStackDecryptedProfileRow {
  item_id: string;
  item_network: string;
  item_domain: string;
  item_type: string;
  item_state: Record<string, unknown>;
  contact?: Partial<Record<SignalStackContactCanonical, SignalStackContactValue>>;
  created_at: string;
  updated_at: string;
}

/**
 * Result of a decrypted-profile fetch. `skipped` holds requested item_ids
 * that were not returned (not found, or not onboarded by the acting org).
 * profiles.length + skipped.length equals the number of distinct requested ids.
 */
export interface SignalStackDecryptedProfiles {
  profiles: SignalStackDecryptedProfileRow[];
  skipped: string[];
}

/**
 * Input for the read-only identity probe, `GET /api/v1/admin/participant`.
 *
 * The probe never writes. Signalstack matches by email and/or phoneNumber
 * (at least one required). `actingOrgId` is sent as the `x-acting-org-id`
 * header so only this aggregator's items are returned. `network` and
 * `domain` select the primary item for the probed domain.
 */
export interface SignalStackProbeUserInput {
  /** Correlation id (the x-request-id header) forwarded to Signals for tracing. */
  requestId?: string;
  /** Signalstack organisation id the probe is performed under. */
  actingOrgId: string;
  /** Email address. At least one of email / phoneNumber is required. */
  email?: string;
  /** Phone number (E.164). At least one of email / phoneNumber is required. */
  phoneNumber?: string;
  /** Network for the primary item, e.g. `blue_dot`. Required. */
  network: string;
  /** Domain for the primary item, e.g. `seeker`. Required. */
  domain: string;
}

/**
 * Response from {@link SignalStackWriterBase.probeUser}.
 *
 *   - `user_exists: false` — new identity.
 *   - `user_exists: true`, `owned_elsewhere: false`, `lifecycle_summary != null`
 *     — own user with a draft, live, or paused item in the probed domain.
 *   - `user_exists: true`, `owned_elsewhere: false`, `lifecycle_summary == null`
 *     — own user with no resumable item in the probed domain.
 *   - `user_exists: true`, `owned_elsewhere: true`, `lifecycle_summary == null`
 *     — user exists but this aggregator owns none of their items. No
 *     lifecycle state from another org is returned.
 *
 * When this org owns no items at all, a foreign user and an own account-only
 * user both read as `owned_elsewhere`. The probe is only a UX hint; the
 * `onboard` response decides the real outcome.
 */
export interface SignalStackProbeUserResult {
  user_exists: boolean;
  owned_elsewhere: boolean;
  lifecycle_summary: {
    primary_item: {
      item_id: string;
      lifecycle_status: 'draft' | 'live' | 'paused';
    };
  } | null;
}

/**
 * Provides a bearer token for Signals client-credentials auth, used instead
 * of the static `apiKey` on {@link HttpSignalStackWriterConfig}.
 *
 * Implementations own caching and refresh. Callers must not assume the token
 * is cached.
 *
 * Implementations:
 *   - KeycloakClientCredentialsTokenProvider: client-credentials grant against
 *     a Keycloak realm, cached until about 30s before expiry.
 *   - Fake: in-memory, with `setToken()`/`failNext()` helpers for tests.
 */
export abstract class SignalStackTokenProviderBase {
  /**
   * Returns a valid access token, fetching or refreshing it as needed.
   *
   * @returns ok(token), or err(BaseError) when the grant fails.
   */
  abstract getToken(): Promise<Result<string, BaseError>>;

  /**
   * Discards any cached token so the next {@link getToken} fetches a new one.
   *
   * Used after a 401: a token can be rejected before it expires (for example
   * after a realm key rotation). Callers invalidate and retry once.
   */
  abstract invalidate(): void;
}

/**
 * Port for the signalstack admin endpoints.
 *
 * Implementations:
 *   - Http: fetch-based adapter for
 *     `POST /api/v1/admin/participant`,
 *     `POST /api/v1/admin/aggregator/upsert`,
 *     `GET /api/v1/aggregator/dashboard[/export]`, and
 *     `POST /api/v1/admin/participant/decrypt`.
 *   - InMemory: Map-backed implementation for unit tests.
 *   - Fake: in-memory with a `seed()` helper for consumer tests.
 */
export abstract class SignalStackWriterBase {
  /**
   * Onboards one participant under the aggregator's signalstack organisation.
   *
   * Sends `x-acting-org-id: {input.actingOrgId}`. Signalstack creates or finds
   * the user by phone/email and writes the profile in one call.
   *
   * @param input - Participant payload, actingOrgId, and channel/source.
   * @returns ok(SignalStackOnboardParticipantResult) on 2xx; err(BaseError) otherwise.
   */
  abstract onboard(
    input: SignalStackOnboardParticipantInput,
  ): Promise<Result<SignalStackOnboardParticipantResult, BaseError>>;

  /**
   * Creates or finds the aggregator's organisation in signalstack.
   *
   * Idempotent on `external_id`: repeat calls return the same `org_id`. Called
   * at admin approval and again at login if the Keycloak attribute is missing.
   *
   * @param input - external_id (our aggregator UUID), display name, and slug.
   * @returns ok(SignalStackAggregator) on 2xx; err(BaseError) otherwise.
   */
  abstract upsertAggregator(
    input: SignalStackUpsertAggregatorInput,
  ): Promise<Result<SignalStackAggregator, BaseError>>;

  /**
   * Fetches the dashboard rollup and paginated participant list.
   *
   * Sends `x-acting-org-id: {query.actingOrgId}`. Signalstack caches the
   * rollup for `metadata.ttl_seconds`; the response is returned unchanged.
   *
   * @param query - actingOrgId plus optional page/limit/status/domain.
   * @returns ok(SignalStackDashboardPage) on 2xx; err(BaseError) otherwise.
   */
  abstract fetchDashboard(
    query: SignalStackDashboardQuery,
  ): Promise<Result<SignalStackDashboardPage, BaseError>>;

  /**
   * Exports the aggregator dashboard as CSV.
   *
   * Sends `x-acting-org-id: {query.actingOrgId}` and `accept: text/csv`. The
   * CSV body is returned unchanged.
   *
   * @param query - actingOrgId plus optional status/domain filter.
   * @returns ok(SignalStackDashboardExport) on 2xx; err(BaseError) otherwise.
   */
  abstract exportDashboardCsv(
    query: SignalStackDashboardExportQuery,
  ): Promise<Result<SignalStackDashboardExport, BaseError>>;

  /**
   * Fetches decrypted profile data for the given item_ids.
   * Server-side only. The admin API key must never reach a browser.
   *
   * @param query - actingOrgId (the aggregator's signalstack org) and itemIds.
   * @returns ok(SignalStackDecryptedProfiles) on 2xx; err(BaseError) otherwise.
   */
  abstract fetchDecryptedProfiles(
    query: SignalStackFetchDecryptedProfilesQuery,
  ): Promise<Result<SignalStackDecryptedProfiles, BaseError>>;

  /**
   * Looks up an identity without writing anything. Safe to retry.
   *
   * Returns `user_exists: false` for new identities and `owned_elsewhere: true`
   * when this aggregator owns none of the user's items. For this aggregator's
   * users, `lifecycle_summary` holds the primary item in the probed domain, or
   * null when there is none. See {@link SignalStackProbeUserResult}.
   *
   * @param input - actingOrgId, email and/or phoneNumber, network, and domain.
   * @returns ok(SignalStackProbeUserResult) on 2xx; err(BaseError) on missing identifiers or failure.
   */
  abstract probeUser(
    input: SignalStackProbeUserInput,
  ): Promise<Result<SignalStackProbeUserResult, BaseError>>;
}
