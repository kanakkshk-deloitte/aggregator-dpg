/**
 * Fetch-backed SignalStackWriter — production impl.
 *
 * Calls `POST {baseUrl}/api/v1/admin/onboard` with `x-api-key`. Any non-2xx
 * response, network failure, or shape mismatch is mapped to UpstreamError so
 * the caller never sees a thrown exception.
 *
 * Every request goes through {@link HttpSignalStackWriter.requestWithRetry},
 * which applies the configured per-attempt timeout and retries transient
 * failures (transport errors, request timeouts, `429`, and `5xx`) with
 * exponential backoff — per the repo `error-handling.md` rule. probe/aggregator
 * upsert/dashboard/get are idempotent (probe/upsert dedupe on identity/
 * `external_id`; dashboard/get are reads). NOTE: `onboard` is NOT idempotent
 * since signals #349 — a create always inserts a new profile, so a retry after
 * a request that actually succeeded can create a duplicate (bounded by the
 * per-user cap). A future idempotency key would restore retry-safety.
 */

import {
  AuthError,
  UpstreamError,
  ValidationError,
} from '@aggregator-dpg/shared-primitives/errors';
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

export interface HttpSignalStackWriterConfig {
  /** Base URL of the signalstack API, e.g. `http://localhost:2743`. No trailing slash. */
  baseUrl: string;
  /** Admin api-key issued by signalstack via better-auth. Sent as `x-api-key`. */
  apiKey: string;
  /**
   * Platform-wide signalstack organisation id under which admin upserts
   * are performed. Sent as `x-acting-org-id` on the
   * `POST /api/v1/admin/aggregator/upsert` call. Required for that call;
   * other endpoints ignore it.
   */
  actingOrgId?: string;
  /** Optional override; defaults to global `fetch`. Lets tests inject a stub. */
  fetchImpl?: typeof fetch;
  /** Optional per-attempt request timeout in ms; off by default. */
  timeoutMs?: number;
  /**
   * Max retry attempts for transient failures (transport error, timeout,
   * `429`, `5xx`). `2` by default → up to 3 total attempts. `0` disables
   * retries (one attempt). Non-transient responses (`4xx` other than `429`)
   * are never retried.
   */
  maxRetries?: number;
  /**
   * Base backoff in ms between retries; doubles each attempt
   * (`base`, `base*2`, `base*4`, …). `200` by default. Set `0` in tests to
   * remove the delay.
   */
  retryBaseMs?: number;
}

export class HttpSignalStackWriter extends SignalStackWriterBase {
  private readonly baseUrl: string;
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  /**
   * Signalstack organisation id sent as `x-acting-org-id` on the aggregator
   * upsert call. `undefined` when not configured — the upsert method then
   * returns `SIGNALSTACK_CONFIG_MISSING` so the caller can soft-fail.
   */
  private readonly actingOrgId: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number | undefined;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;

  constructor(config: HttpSignalStackWriterConfig) {
    super();
    if (!config.baseUrl) {
      throw new Error('HttpSignalStackWriter requires baseUrl');
    }
    if (!config.apiKey) {
      throw new Error('HttpSignalStackWriter requires apiKey');
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    // Plan-C tier-aware participant upsert. Replaced the old
    // `/admin/onboard_participant` route which now returns 404.
    this.endpoint = `${this.baseUrl}/api/v1/admin/participant`;
    this.headers = {
      'content-type': 'application/json',
      'x-api-key': config.apiKey,
    };
    this.actingOrgId = config.actingOrgId;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs;
    this.maxRetries = config.maxRetries ?? 2;
    this.retryBaseMs = config.retryBaseMs ?? 200;
  }

  /**
   * Perform a fetch with a per-attempt timeout and bounded exponential-backoff
   * retry of transient failures.
   *
   * Retries on: a thrown transport error, an aborted (timed-out) request, and
   * a `429` or `5xx` response. A `4xx` (other than `429`) is returned to the
   * caller immediately so it can map the response to the right typed error.
   * When all attempts are exhausted the last thrown error is re-thrown (so the
   * caller's `catch` maps it to a `SIGNALSTACK_TIMEOUT` / `_TRANSPORT_FAILED`),
   * or the last failing `Response` is returned (so the caller maps the status).
   *
   * @param url - Absolute request URL.
   * @param init - Fetch init; the `signal` is supplied per attempt.
   * @returns The final `Response` (success, non-retryable, or exhausted).
   * @throws The last transport/timeout error when every attempt threw.
   */
  private async requestWithRetry(url: string, init: RequestInit): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = this.timeoutMs ? new AbortController() : undefined;
      const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : undefined;
      try {
        const res = await this.fetchImpl(url, {
          ...init,
          ...(controller ? { signal: controller.signal } : {}),
        });
        if (attempt < this.maxRetries && (res.status === 429 || res.status >= 500)) {
          await this.backoff(attempt);
          continue;
        }
        return res;
      } catch (e) {
        lastError = e;
        if (attempt < this.maxRetries) {
          await this.backoff(attempt);
          continue;
        }
        throw e;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    // Unreachable — the loop always returns or throws — but satisfies the
    // type checker that the function returns on every path.
    throw lastError ?? new Error('signalstack request failed');
  }

  /** Sleep for `retryBaseMs * 2^attempt` ms before the next retry. */
  private backoff(attempt: number): Promise<void> {
    const ms = this.retryBaseMs * 2 ** attempt;
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  override async onboard(
    input: SignalStackOnboardParticipantInput,
  ): Promise<Result<SignalStackOnboardParticipantResult, BaseError>> {
    const guardErr = this.guardInput(input);
    if (guardErr) return err(guardErr);

    const submitMode: 'with_item' | 'account_only' = input.submit_mode ?? 'with_item';
    const body: Record<string, unknown> = {
      name: input.name,
      channel: input.channel,
      source_id: input.source_id,
      network: input.network,
      domain: input.domain,
      item_type: input.item_type,
    };
    // Consent is recorded via the `compliance` array (the live mechanism);
    // the deprecated `terms_accepted`/`privacy_accepted` flags are never sent.
    // `age` accompanies compliance on guardian-gated domains.
    if (input.compliance && input.compliance.length > 0) body.compliance = input.compliance;
    if (typeof input.age === 'number') body.age = input.age;
    // Signalstack Plan-C renamed the body field from `profile` to
    // `item_state` — the value is unchanged. When the caller opts out of
    // item creation (`submit_mode === 'account_only'`), omit `item_state`
    // entirely so signals creates only the user row. This is the
    // upstream-friendly way to flag "account only": signals' own contract
    // treats an absent item_state as "no item" rather than introducing a
    // bespoke flag.
    if (submitMode !== 'account_only') {
      body.item_state = input.profile;
    }
    // Signalstack's user schema treats email / phoneNumber as `.optional()`
    // (not `.nullable()`), so omit the keys entirely when we have no value
    // rather than passing null — a literal null trips Zod's `expected:
    // string` check and the whole push fails 400.
    if (input.phoneNumber) body.phone_number = input.phoneNumber;
    if (input.email) body.email = input.email;

    const headers = {
      ...this.headers,
      'x-acting-org-id': input.actingOrgId,
      ...(input.requestId ? { 'x-request-id': input.requestId } : {}),
    };

    try {
      const res = await this.requestWithRetry(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const bodyText = await safeReadText(res);
        const upstreamMsg = extractUpstreamMessage(bodyText);
        const upstreamCode = extractUpstreamCode(bodyText);
        // Surface signalstack's own message (e.g. `INVALID_ITEM_STATE: must be
        // equal to one of the allowed values`) when present so the caller can
        // funnel it into the user-visible errors.csv. Falls back to the bare
        // status code message if the body isn't JSON or carries no message.
        const message = upstreamMsg
          ? `signalstack onboard returned ${res.status}: ${upstreamMsg}`
          : `signalstack onboard returned ${res.status}`;
        // Distinguish the per-user profile cap (signals #349) from other 409s
        // so callers can categorise it as a user/data condition rather than a
        // generic conflict or system error.
        const code =
          res.status === 409 && upstreamCode === 'PROFILE_LIMIT_REACHED'
            ? 'SIGNALSTACK_PROFILE_LIMIT_REACHED'
            : this.codeForStatus(res.status);
        // `signalsMessage` is the bare, user-safe sentence (no infra prefixes) —
        // callers surfacing errors to end users (public forms) should prefer it;
        // errors.csv/operators keep the prefixed `message`.
        const signalsMessage = extractUpstreamMessageText(bodyText);
        return err(
          new UpstreamError(message, {
            code,
            details: {
              status: res.status,
              body: bodyText,
              ...(signalsMessage ? { signalsMessage } : {}),
            },
          }),
        );
      }

      // Plan-C response shape:
      //   { user_id, user_existed, onboarded_at, items: [{ item_id, lifecycle_status?, ... }] }
      // The writer's public result still surfaces a flat
      // `profile_item_id` so existing callers (worker, registration-link
      // routes, audit logs) stay unchanged — pick the matching item for
      // the requested network/domain/type, falling back to the first
      // item when the request inserted a single row.
      const raw = (await res.json()) as {
        user_id?: unknown;
        user_existed?: unknown;
        owned_elsewhere?: unknown;
        items?: Array<{
          item_id?: unknown;
          item_network?: unknown;
          item_domain?: unknown;
          item_type?: unknown;
          lifecycle_status?: unknown;
        }>;
        onboarded_at?: unknown;
      };
      if (!raw || typeof raw !== 'object' || typeof raw.user_id !== 'string') {
        return err(
          new UpstreamError('signalstack onboard returned unexpected payload', {
            code: 'SIGNALSTACK_BAD_RESPONSE',
            details: { payload: raw },
          }),
        );
      }
      const items = Array.isArray(raw.items) ? raw.items : [];
      const ownedElsewhereSignal = raw.owned_elsewhere === true;

      // account_only path — signalstack created (or idempotently re-ensured)
      // the user row but no item, so an empty `items` array is EXPECTED here,
      // not a sign of foreign ownership. Re-submitting the same phone/email is
      // an idempotent SUCCESS — signals returns the same user_id — so a
      // returning own-aggregator user (`user_existed: true`) is NOT flagged
      // `already_registered` (which would make the caller 409-skip it). Only a
      // genuinely foreign user (explicit `owned_elsewhere`) skips. Checked
      // BEFORE the with-item heuristic, which treats empty items as
      // owned-elsewhere — invalid for account_only.
      if (submitMode === 'account_only') {
        return ok({
          user_id: raw.user_id,
          profile_item_id: '',
          onboarded_at: typeof raw.onboarded_at === 'string' ? raw.onboarded_at : '',
          already_registered: false,
          owned_elsewhere: ownedElsewhereSignal,
        });
      }
      // with_item path — an existing user with an empty `items` array belongs
      // to a different aggregator (that org's items are private to it).
      // signalstack returns `user_existed: true` (and, in newer builds, an
      // explicit `owned_elsewhere: true`). Not an error — surface it as an
      // already-registered / owned_elsewhere result so the caller records a
      // `skipped` outcome instead of a 502.
      if ((raw.user_existed === true || ownedElsewhereSignal) && items.length === 0) {
        return ok({
          user_id: raw.user_id,
          profile_item_id: '',
          onboarded_at: typeof raw.onboarded_at === 'string' ? raw.onboarded_at : '',
          already_registered: true,
          owned_elsewhere: true,
        });
      }
      const matched =
        items.find(
          (it) =>
            it.item_network === input.network &&
            it.item_domain === input.domain &&
            it.item_type === input.item_type,
        ) ?? items[0];
      if (!matched || typeof matched.item_id !== 'string') {
        return err(
          new UpstreamError('signalstack onboard returned no item for the request', {
            code: 'SIGNALSTACK_BAD_RESPONSE',
            details: { payload: raw },
          }),
        );
      }
      const lifecycleStatus =
        matched.lifecycle_status === 'draft' ||
        matched.lifecycle_status === 'live' ||
        matched.lifecycle_status === 'paused'
          ? matched.lifecycle_status
          : undefined;
      const result: SignalStackOnboardParticipantResult = {
        user_id: raw.user_id,
        profile_item_id: matched.item_id,
        onboarded_at: typeof raw.onboarded_at === 'string' ? raw.onboarded_at : '',
        owned_elsewhere: false,
        ...(lifecycleStatus !== undefined ? { lifecycle_status: lifecycleStatus } : {}),
      };
      return ok(result);
    } catch (e) {
      const cause = e as Error;
      const aborted = cause.name === 'AbortError';
      return err(
        new UpstreamError(
          aborted
            ? `signalstack onboard timed out after ${this.timeoutMs}ms`
            : `signalstack onboard transport failure: ${cause.message}`,
          {
            cause,
            code: aborted ? 'SIGNALSTACK_TIMEOUT' : 'SIGNALSTACK_TRANSPORT_FAILED',
          },
        ),
      );
    }
  }

  override async listItemsByAggregator(
    query: SignalStackItemQuery,
  ): Promise<Result<SignalStackItemList, BaseError>> {
    if (!query.aggregator_id || !query.item_network || !query.item_domain) {
      return err(
        new ValidationError('aggregator_id, item_network, and item_domain are required', {
          code: 'SIGNALSTACK_INPUT_INVALID',
        }),
      );
    }

    // Local-only network fetch (POST): hits this signalstack instance's
    // items table directly with the aggregator_id filter. The sibling GET
    // /api/v1/network/item/fetch aggregates across every instance listed in
    // the network config and external instances do not know about
    // aggregator_id, so totals there are inflated. fetch_local is the
    // correct endpoint for an aggregator dashboard scoped to its own data.
    const url = `${this.baseUrl}/api/v1/network/item/fetch_local`;
    const body = {
      aggregator_id: query.aggregator_id,
      item_network: query.item_network,
      item_domain: query.item_domain,
      ...(query.item_type ? { item_type: query.item_type } : {}),
      // Forward the lifecycle filter only when set; signals defaults to
      // 'live_only' so the writer omits the field for that case to keep
      // the wire shape minimal and let signals own the default.
      ...(query.lifecycle_filter ? { lifecycle_filter: query.lifecycle_filter } : {}),
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
    };
    const headers = {
      ...this.headers,
      ...(query.requestId ? { 'x-request-id': query.requestId } : {}),
    };
    try {
      const res = await this.requestWithRetry(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const bodyText = await safeReadText(res);
        return err(
          new UpstreamError(`signalstack list_items returned ${res.status}`, {
            code: this.codeForStatus(res.status),
            details: { status: res.status, body: bodyText },
          }),
        );
      }

      const payload = (await res.json()) as SignalStackItemList;
      if (!payload || typeof payload !== 'object' || !Array.isArray(payload.items)) {
        return err(
          new UpstreamError('signalstack list_items returned unexpected payload', {
            code: 'SIGNALSTACK_BAD_RESPONSE',
            details: { payload },
          }),
        );
      }
      return ok(payload);
    } catch (e) {
      const cause = e as Error;
      const aborted = cause.name === 'AbortError';
      return err(
        new UpstreamError(
          aborted
            ? `signalstack list_items timed out after ${this.timeoutMs}ms`
            : `signalstack list_items transport failure: ${cause.message}`,
          {
            cause,
            code: aborted ? 'SIGNALSTACK_TIMEOUT' : 'SIGNALSTACK_TRANSPORT_FAILED',
          },
        ),
      );
    }
  }

  /**
   * Calls `POST {baseUrl}/api/v1/admin/aggregator/upsert` with the platform
   * admin api-key and the configured `x-acting-org-id` header. The remote
   * endpoint is idempotent on `external_id` (our Postgres aggregator UUID),
   * so the same input may be re-fired safely from a login-time fallback.
   *
   * Non-2xx responses, transport failures, and unexpected payload shapes
   * are mapped to `UpstreamError` — no exception ever leaves the method.
   *
   * @param input - external_id (our aggregator UUID) + display name + slug
   *   + optional metadata bag forwarded verbatim to signalstack.
   * @returns ok(SignalStackAggregator) on 2xx with a non-empty `org_id`;
   *   err(BaseError) with a `SIGNALSTACK_*` code on every failure path.
   */
  override async upsertAggregator(
    input: SignalStackUpsertAggregatorInput,
  ): Promise<Result<SignalStackAggregator, BaseError>> {
    if (!input?.external_id || !input?.name || !input?.slug) {
      return err(
        new ValidationError('external_id, name, and slug are required', {
          code: 'SIGNALSTACK_INPUT_INVALID',
        }),
      );
    }
    if (!this.actingOrgId) {
      return err(
        new UpstreamError('actingOrgId is required for aggregator upsert', {
          code: 'SIGNALSTACK_CONFIG_MISSING',
        }),
      );
    }

    const url = `${this.baseUrl}/api/v1/admin/aggregator/upsert`;
    const body: Record<string, unknown> = {
      external_id: input.external_id,
      name: input.name,
      slug: input.slug,
    };
    if (input.domains && input.domains.length > 0) body.domains = input.domains;
    if (input.metadata) body.metadata = input.metadata;

    const headers = {
      ...this.headers,
      'x-acting-org-id': this.actingOrgId,
      ...(input.requestId ? { 'x-request-id': input.requestId } : {}),
    };

    try {
      const res = await this.requestWithRetry(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const bodyText = await safeReadText(res);
        const upstreamMsg = extractUpstreamMessage(bodyText);
        const message = upstreamMsg
          ? `signalstack aggregator upsert returned ${res.status}: ${upstreamMsg}`
          : `signalstack aggregator upsert returned ${res.status}`;
        return err(
          new UpstreamError(message, {
            code: this.codeForStatus(res.status),
            details: { status: res.status, body: bodyText },
          }),
        );
      }

      const payload = (await res.json()) as SignalStackAggregator;
      if (
        !payload ||
        typeof payload !== 'object' ||
        typeof payload.org_id !== 'string' ||
        payload.org_id.length === 0
      ) {
        return err(
          new UpstreamError('signalstack aggregator upsert returned unexpected payload', {
            code: 'SIGNALSTACK_BAD_RESPONSE',
            details: { payload },
          }),
        );
      }
      return ok(payload);
    } catch (e) {
      const cause = e as Error;
      const aborted = cause.name === 'AbortError';
      return err(
        new UpstreamError(
          aborted
            ? `signalstack aggregator upsert timed out after ${this.timeoutMs}ms`
            : `signalstack aggregator upsert transport failure: ${cause.message}`,
          {
            cause,
            code: aborted ? 'SIGNALSTACK_TIMEOUT' : 'SIGNALSTACK_TRANSPORT_FAILED',
          },
        ),
      );
    }
  }

  /**
   * Fetches the aggregator dashboard payload from signalstack.
   *
   * Builds a query string from `page`, `limit`, and `status` only — the
   * `domain` field is reserved for the eventual provider rollout and is
   * intentionally NOT forwarded today because signalstack's dashboard
   * endpoint is seeker-only at present. When upstream gains domain
   * support, swap the predicate that gates the `domain` append below.
   *
   * @param query - actingOrgId + optional pagination/status/domain.
   * @returns ok(SignalStackDashboardPage) on 2xx; err(BaseError) otherwise.
   */
  override async fetchDashboard(
    query: SignalStackDashboardQuery,
  ): Promise<Result<SignalStackDashboardPage, BaseError>> {
    if (!query?.actingOrgId) {
      return err(
        new ValidationError('actingOrgId is required for dashboard fetch', {
          code: 'SIGNALSTACK_INPUT_INVALID',
        }),
      );
    }

    const params = new URLSearchParams();
    if (query.page !== undefined) params.set('page', String(query.page));
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.status) params.set('status', query.status);
    if (query.lifecycle && query.lifecycle.length > 0)
      params.set('lifecycle', query.lifecycle.join(','));
    if (query.refresh) params.set('refresh', 'true');
    // domain intentionally NOT forwarded — see method docblock.
    const qs = params.toString();
    const url = `${this.baseUrl}/api/v1/aggregator/dashboard${qs ? `?${qs}` : ''}`;

    const headers = {
      ...this.headers,
      'x-acting-org-id': query.actingOrgId,
      ...(query.requestId ? { 'x-request-id': query.requestId } : {}),
    };

    try {
      const res = await this.requestWithRetry(url, {
        method: 'GET',
        headers,
      });

      if (!res.ok) {
        const bodyText = await safeReadText(res);
        const upstreamMsg = extractUpstreamMessage(bodyText);
        const message = upstreamMsg
          ? `signalstack dashboard returned ${res.status}: ${upstreamMsg}`
          : `signalstack dashboard returned ${res.status}`;
        return err(
          new UpstreamError(message, {
            code: this.codeForStatus(res.status),
            details: { status: res.status, body: bodyText },
          }),
        );
      }

      const payload = (await res.json()) as SignalStackDashboardPage;
      if (
        !payload ||
        typeof payload !== 'object' ||
        !('by_domain' in payload) ||
        !payload.by_domain ||
        typeof payload.by_domain !== 'object'
      ) {
        return err(
          new UpstreamError('Signalstack dashboard payload missing by_domain', {
            code: 'SIGNALSTACK_BAD_RESPONSE',
          }),
        );
      }
      if (!payload.metadata || typeof payload.metadata !== 'object') {
        return err(
          new UpstreamError('Signalstack dashboard payload missing metadata', {
            code: 'SIGNALSTACK_BAD_RESPONSE',
          }),
        );
      }

      const byDomain = payload.by_domain as Record<string, unknown>;
      for (const [domainId, sliceRaw] of Object.entries(byDomain)) {
        if (!sliceRaw || typeof sliceRaw !== 'object') {
          return err(
            new UpstreamError(`Signalstack domain slice "${domainId}" is not an object`, {
              code: 'SIGNALSTACK_BAD_RESPONSE',
            }),
          );
        }
        const slice = sliceRaw as Record<string, unknown>;
        if (!Array.isArray(slice.items)) {
          return err(
            new UpstreamError(`Signalstack slice "${domainId}" missing items[]`, {
              code: 'SIGNALSTACK_BAD_RESPONSE',
            }),
          );
        }
        if (!slice.rollup || typeof slice.rollup !== 'object') {
          return err(
            new UpstreamError(`Signalstack slice "${domainId}" missing rollup`, {
              code: 'SIGNALSTACK_BAD_RESPONSE',
            }),
          );
        }
        const r = slice.rollup as Record<string, unknown>;
        if (typeof r.total_items !== 'number') {
          return err(
            new UpstreamError(`Signalstack slice "${domainId}" rollup missing total_items`, {
              code: 'SIGNALSTACK_BAD_RESPONSE',
            }),
          );
        }
        if (!r.by_initiated_action_status || typeof r.by_initiated_action_status !== 'object') {
          return err(
            new UpstreamError(
              `Signalstack slice "${domainId}" rollup missing by_initiated_action_status`,
              { code: 'SIGNALSTACK_BAD_RESPONSE' },
            ),
          );
        }
        if (!r.by_received_action_status || typeof r.by_received_action_status !== 'object') {
          return err(
            new UpstreamError(
              `Signalstack slice "${domainId}" rollup missing by_received_action_status`,
              { code: 'SIGNALSTACK_BAD_RESPONSE' },
            ),
          );
        }
        if (!r.by_status || typeof r.by_status !== 'object') {
          return err(
            new UpstreamError(`Signalstack slice "${domainId}" rollup missing by_status`, {
              code: 'SIGNALSTACK_BAD_RESPONSE',
            }),
          );
        }
      }
      return ok(payload);
    } catch (e) {
      const cause = e as Error;
      const aborted = cause.name === 'AbortError';
      return err(
        new UpstreamError(
          aborted
            ? `signalstack dashboard timed out after ${this.timeoutMs}ms`
            : `signalstack dashboard transport failure: ${cause.message}`,
          {
            cause,
            code: aborted ? 'SIGNALSTACK_TIMEOUT' : 'SIGNALSTACK_TRANSPORT_FAILED',
          },
        ),
      );
    }
  }

  /**
   * Downloads the aggregator dashboard as a CSV file from signalstack.
   *
   * Forwards `status` as the only query parameter today (signalstack's
   * export endpoint accepts no others); `domain` is reserved for the
   * provider rollout and intentionally NOT forwarded. The
   * `accept: text/csv` header tells signalstack to return the CSV body
   * directly — the writer hands the raw string back and the route
   * streams it as `text/csv` with a `Content-Disposition` attachment
   * header.
   *
   * The default filename embeds the status filter and current date in
   * UTC; the API route may override.
   *
   * @param query - actingOrgId + optional status/domain.
   * @returns ok(SignalStackDashboardExport) on 2xx; err(BaseError) on
   *   transport failure, validation rejection, or non-2xx.
   */
  override async exportDashboardCsv(
    query: SignalStackDashboardExportQuery,
  ): Promise<Result<SignalStackDashboardExport, BaseError>> {
    if (!query?.actingOrgId) {
      return err(
        new ValidationError('actingOrgId is required for dashboard export', {
          code: 'SIGNALSTACK_INPUT_INVALID',
        }),
      );
    }

    const params = new URLSearchParams();
    if (query.status) params.set('status', query.status);
    if (query.refresh) params.set('refresh', 'true');
    const qs = params.toString();
    const url = `${this.baseUrl}/api/v1/aggregator/dashboard/export${qs ? `?${qs}` : ''}`;

    const headers = {
      ...this.headers,
      'x-acting-org-id': query.actingOrgId,
      accept: 'text/csv',
      ...(query.requestId ? { 'x-request-id': query.requestId } : {}),
    };

    try {
      const res = await this.requestWithRetry(url, {
        method: 'GET',
        headers,
      });

      if (!res.ok) {
        const bodyText = await safeReadText(res);
        const upstreamMsg = extractUpstreamMessage(bodyText);
        const message = upstreamMsg
          ? `signalstack dashboard export returned ${res.status}: ${upstreamMsg}`
          : `signalstack dashboard export returned ${res.status}`;
        return err(
          new UpstreamError(message, {
            code: this.codeForStatus(res.status),
            details: { status: res.status, body: bodyText },
          }),
        );
      }

      const csv = await safeReadText(res);
      if (!csv) {
        return err(
          new UpstreamError('signalstack dashboard export returned empty body', {
            code: 'SIGNALSTACK_BAD_RESPONSE',
          }),
        );
      }
      return ok({ csv, filename: buildDefaultExportFilename(query.status) });
    } catch (e) {
      const cause = e as Error;
      const aborted = cause.name === 'AbortError';
      return err(
        new UpstreamError(
          aborted
            ? `signalstack dashboard export timed out after ${this.timeoutMs}ms`
            : `signalstack dashboard export transport failure: ${cause.message}`,
          {
            cause,
            code: aborted ? 'SIGNALSTACK_TIMEOUT' : 'SIGNALSTACK_TRANSPORT_FAILED',
          },
        ),
      );
    }
  }

  override async fetchDecryptedProfiles(
    query: SignalStackFetchDecryptedProfilesQuery,
  ): Promise<Result<SignalStackDecryptedProfiles, BaseError>> {
    if (!query?.actingOrgId) {
      return err(
        new ValidationError('actingOrgId is required for decrypted profile fetch', {
          code: 'SIGNALSTACK_INPUT_INVALID',
        }),
      );
    }
    if (!Array.isArray(query.itemIds) || query.itemIds.length === 0) {
      return err(
        new ValidationError('itemIds must be a non-empty array', {
          code: 'SIGNALSTACK_INPUT_INVALID',
        }),
      );
    }

    const url = `${this.baseUrl}/api/v1/admin/participant/decrypt`;
    const headers = {
      ...this.headers,
      'x-acting-org-id': query.actingOrgId,
      ...(query.requestId ? { 'x-request-id': query.requestId } : {}),
    };

    try {
      const res = await this.requestWithRetry(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ item_ids: query.itemIds }),
      });

      if (!res.ok) {
        const bodyText = await safeReadText(res);
        const upstreamMsg = extractUpstreamMessage(bodyText);
        const message = upstreamMsg
          ? `signalstack decrypt returned ${res.status}: ${upstreamMsg}`
          : `signalstack decrypt returned ${res.status}`;
        return err(
          new UpstreamError(message, {
            code: this.codeForStatus(res.status),
            details: { status: res.status, body: bodyText },
          }),
        );
      }

      const parsed = (await res.json()) as SignalStackDecryptedProfiles;
      if (!parsed || !Array.isArray(parsed.profiles) || !Array.isArray(parsed.skipped)) {
        return err(
          new UpstreamError('signalstack decrypt returned a malformed body', {
            code: 'SIGNALSTACK_BAD_RESPONSE',
          }),
        );
      }
      return ok({ profiles: parsed.profiles, skipped: parsed.skipped });
    } catch (e) {
      const cause = e as Error;
      const aborted = cause.name === 'AbortError';
      return err(
        new UpstreamError(
          aborted
            ? `signalstack decrypt timed out after ${this.timeoutMs}ms`
            : `signalstack decrypt transport failure: ${cause.message}`,
          {
            cause,
            code: aborted ? 'SIGNALSTACK_TIMEOUT' : 'SIGNALSTACK_TRANSPORT_FAILED',
          },
        ),
      );
    }
  }

  /**
   * Identity-only probe against signalstack's `/admin/participant` endpoint.
   *
   * Calls the same POST endpoint as {@link onboard} but with no
   * `item_state` in the body and a sentinel `name: 'lookup'`. Signalstack
   * treats that as an account-only path — it may create the user row but
   * never an item — so the probe is safely idempotent for the caller.
   * The response is reshaped into the slim {@link SignalStackProbeUserResult}
   * tri-state so the caller never has to re-derive owned_elsewhere /
   * lifecycle_summary from the raw items array.
   *
   * @param input - actingOrgId + email and/or phoneNumber + network/domain.
   * @returns ok(SignalStackProbeUserResult) on 2xx; err(BaseError) on
   *   validation failure, transport failure, or non-2xx.
   */
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
    if (!input.email && !input.phoneNumber) {
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

    // Probe body — deliberately omits `item_state` so signals' Plan-C
    // account-only path runs (creates user row at most; never an item).
    // The sentinel `name: 'lookup'` mirrors what signals' own admin UI
    // sends for identity-only checks. `channel` is required by signals'
    // UpsertParticipantRequest schema even on the account-only path; the
    // probe always originates from the public registration link, so 'link'
    // is the truthful attribution surface.
    const body: Record<string, unknown> = {
      name: 'lookup',
      channel: 'link',
      network: input.network,
      domain: input.domain,
    };
    if (input.email) body.email = input.email;
    if (input.phoneNumber) body.phone_number = input.phoneNumber;

    const headers = {
      ...this.headers,
      'x-acting-org-id': input.actingOrgId,
      ...(input.requestId ? { 'x-request-id': input.requestId } : {}),
    };

    try {
      const res = await this.requestWithRetry(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const bodyText = await safeReadText(res);
        const upstreamMsg = extractUpstreamMessage(bodyText);
        const message = upstreamMsg
          ? `signalstack probe returned ${res.status}: ${upstreamMsg}`
          : `signalstack probe returned ${res.status}`;
        if (res.status === 400) {
          return err(
            new ValidationError(message, {
              code: this.codeForStatus(res.status),
              details: { status: res.status, body: bodyText },
            }),
          );
        }
        if (res.status === 401 || res.status === 403) {
          return err(
            new AuthError(message, {
              code: this.codeForStatus(res.status),
              details: { status: res.status, body: bodyText },
            }),
          );
        }
        return err(
          new UpstreamError(message, {
            code: this.codeForStatus(res.status),
            details: { status: res.status, body: bodyText },
          }),
        );
      }

      // Account-only response shape:
      //   { user_id, user_existed, owned_elsewhere?, items: [] | [item] }
      // Reshape into the tri-state the caller branches on.
      const raw = (await res.json()) as {
        user_id?: unknown;
        user_existed?: unknown;
        owned_elsewhere?: unknown;
        items?: Array<{
          item_id?: unknown;
          lifecycle_status?: unknown;
        }>;
      };
      if (!raw || typeof raw !== 'object') {
        return err(
          new UpstreamError('signalstack probe returned unexpected payload', {
            code: 'SIGNALSTACK_BAD_RESPONSE',
            details: { payload: raw },
          }),
        );
      }

      const userExisted = raw.user_existed === true;
      const ownedElsewhere = raw.owned_elsewhere === true;

      if (userExisted && ownedElsewhere) {
        return ok({
          user_exists: true,
          owned_elsewhere: true,
          lifecycle_summary: null,
        });
      }

      const items = Array.isArray(raw.items) ? raw.items : [];
      if (userExisted && items.length > 0) {
        const first = items[0]!;
        const itemId = typeof first.item_id === 'string' ? first.item_id : '';
        if (!itemId) {
          return err(
            new UpstreamError('signalstack probe primary item missing item_id', {
              code: 'SIGNALSTACK_BAD_RESPONSE',
              details: { payload: raw },
            }),
          );
        }
        // Back-compat fallback: older signalstack builds omit lifecycle_status
        // on the account-only response. Treat absent as a live item — same
        // default the resolveLifecycle helper in apps/api applies for read-side
        // rows. The writer cannot import that helper (apps/api sits above this
        // package in the dep graph), so inline the fallback here.
        const lifecycleStatus =
          first.lifecycle_status === 'draft' ||
          first.lifecycle_status === 'live' ||
          first.lifecycle_status === 'paused'
            ? first.lifecycle_status
            : 'live';
        return ok({
          user_exists: true,
          owned_elsewhere: false,
          lifecycle_summary: {
            primary_item: {
              item_id: itemId,
              lifecycle_status: lifecycleStatus,
            },
          },
        });
      }

      if (userExisted) {
        // Own user but no item yet (account-only probe response).
        return ok({
          user_exists: true,
          owned_elsewhere: false,
          lifecycle_summary: null,
        });
      }

      // user_existed: false (or absent) — signals either created the row
      // just now or there is no matching identity. Either way the caller
      // treats the user as new.
      return ok({
        user_exists: false,
        owned_elsewhere: false,
        lifecycle_summary: null,
      });
    } catch (e) {
      const cause = e as Error;
      const aborted = cause.name === 'AbortError';
      return err(
        new UpstreamError(
          aborted
            ? `signalstack probe timed out after ${this.timeoutMs}ms`
            : `signalstack probe transport failure: ${cause.message}`,
          {
            cause,
            code: aborted ? 'SIGNALSTACK_TIMEOUT' : 'SIGNALSTACK_TRANSPORT_FAILED',
          },
        ),
      );
    }
  }

  /**
   * Fetch a single signals item by `item_id` from the
   * `POST /api/v1/network/item/fetch_local` endpoint.
   *
   * Generic single-item read primitive. A 404 (or empty `items[]`) is
   * mapped to `ok(null)` so a caller can distinguish "absent" from an
   * error. All other non-2xx responses and transport failures surface as
   * `UpstreamError`.
   *
   * @param query - Item id to look up.
   * @returns ok(SignalStackProfile) on hit; ok(null) on absent;
   *   err(BaseError) on transport / protocol failure.
   */
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

    // fetch_local accepts a server-side `item_id` filter; signalstack
    // returns a list payload with 0 or 1 row. We collapse the list into
    // a single-item result here so the caller doesn't have to.
    const url = `${this.baseUrl}/api/v1/network/item/fetch_local`;
    const body = { item_id: query.item_id, limit: 1, offset: 0 };

    const headers = {
      ...this.headers,
      ...(query.requestId ? { 'x-request-id': query.requestId } : {}),
    };
    try {
      const res = await this.requestWithRetry(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (res.status === 404) return ok(null);

      if (!res.ok) {
        const bodyText = await safeReadText(res);
        return err(
          new UpstreamError(`signalstack get_item returned ${res.status}`, {
            code: this.codeForStatus(res.status),
            details: { status: res.status, body: bodyText },
          }),
        );
      }

      const payload = (await res.json()) as { items?: unknown };
      if (!payload || typeof payload !== 'object' || !Array.isArray(payload.items)) {
        return err(
          new UpstreamError('signalstack get_item returned unexpected payload', {
            code: 'SIGNALSTACK_BAD_RESPONSE',
            details: { payload },
          }),
        );
      }
      const first = payload.items[0];
      if (!first || typeof first !== 'object') return ok(null);
      return ok(first as SignalStackProfile);
    } catch (e) {
      const cause = e as Error;
      const aborted = cause.name === 'AbortError';
      return err(
        new UpstreamError(
          aborted
            ? `signalstack get_item timed out after ${this.timeoutMs}ms`
            : `signalstack get_item transport failure: ${cause.message}`,
          {
            cause,
            code: aborted ? 'SIGNALSTACK_TIMEOUT' : 'SIGNALSTACK_TRANSPORT_FAILED',
          },
        ),
      );
    }
  }

  private guardInput(input: SignalStackOnboardParticipantInput): BaseError | null {
    // Pre-send input validation → ValidationError (malformed input before the
    // request leaves us), consistent with probeUser/getItem. The machine code
    // stays SIGNALSTACK_INPUT_INVALID so existing callers/branches are intact.
    if (!input?.actingOrgId) {
      return new ValidationError('actingOrgId is required', {
        code: 'SIGNALSTACK_INPUT_INVALID',
      });
    }
    if (!input.name) {
      return new ValidationError('name is required', {
        code: 'SIGNALSTACK_INPUT_INVALID',
      });
    }
    const hasEmail = Boolean(input.email);
    const hasPhone = Boolean(input.phoneNumber);
    if (!hasEmail && !hasPhone) {
      return new ValidationError('either email or phoneNumber is required', {
        code: 'SIGNALSTACK_INPUT_INVALID',
      });
    }
    if (!input.network || !input.domain || !input.item_type) {
      return new ValidationError('network, domain, and item_type are required', {
        code: 'SIGNALSTACK_INPUT_INVALID',
      });
    }
    if (!input.source_id || !input.channel) {
      return new ValidationError('channel and source_id are required', {
        code: 'SIGNALSTACK_INPUT_INVALID',
      });
    }
    if (!input.profile || typeof input.profile !== 'object') {
      return new ValidationError('profile is required', {
        code: 'SIGNALSTACK_INPUT_INVALID',
      });
    }
    return null;
  }

  private codeForStatus(status: number): string {
    if (status === 400) return 'SIGNALSTACK_BAD_REQUEST';
    if (status === 401 || status === 403) return 'SIGNALSTACK_FORBIDDEN';
    if (status === 404) return 'SIGNALSTACK_NOT_FOUND';
    if (status === 409) return 'SIGNALSTACK_CONFLICT';
    if (status >= 500) return 'SIGNALSTACK_SERVER_ERROR';
    return 'SIGNALSTACK_UPSTREAM_ERROR';
  }
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/**
 * Extract the human-readable error string from a signalstack JSON error body.
 *
 * Signalstack returns shapes like:
 *   { "error": "INVALID_ITEM_STATE", "message": "Invalid item_state: must be …" }
 *   { "statusCode": 400, "error": "Bad Request", "message": "body/x Invalid …" }
 *   { "error": { "message": "…" } }
 *
 * Returns the most specific message available, or `null` if the body is not
 * JSON or carries no usable text. Combines `error` + `message` when both are
 * present so the caller sees both the machine code and the human text.
 */
/** Extract signalstack's machine error code (the JSON `error` field), if any. */
function extractUpstreamCode(bodyText: string): string | null {
  if (!bodyText) return null;
  try {
    const obj = JSON.parse(bodyText) as Record<string, unknown>;
    const e = obj?.['error'];
    if (typeof e === 'string') return e;
    if (isObject(e) && typeof e['code'] === 'string') return e['code'] as string;
  } catch {
    /* non-JSON body — no machine code */
  }
  return null;
}

/**
 * The bare human `message` field from a signalstack JSON error body — WITHOUT
 * the `"<CODE>: "` prefix that {@link extractUpstreamMessage} adds. Suitable for
 * showing directly to an end user (e.g. a public registration form).
 */
function extractUpstreamMessageText(bodyText: string): string | null {
  if (!bodyText) return null;
  try {
    const obj = JSON.parse(bodyText) as Record<string, unknown>;
    if (typeof obj['message'] === 'string') return obj['message'] as string;
    const e = obj['error'];
    if (isObject(e) && typeof e['message'] === 'string') return e['message'] as string;
  } catch {
    /* non-JSON body */
  }
  return null;
}

function extractUpstreamMessage(bodyText: string): string | null {
  if (!bodyText) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    // Non-JSON body — return the raw text trimmed to a sensible length.
    const trimmed = bodyText.trim();
    return trimmed.length > 0 ? trimmed.slice(0, 500) : null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const errField = obj['error'];
  const errCode =
    typeof errField === 'string'
      ? errField
      : isObject(errField) && typeof errField['code'] === 'string'
        ? (errField['code'] as string)
        : null;
  const messageText =
    typeof obj['message'] === 'string'
      ? (obj['message'] as string)
      : isObject(errField) && typeof errField['message'] === 'string'
        ? (errField['message'] as string)
        : null;
  if (errCode && messageText) return `${errCode}: ${messageText}`;
  if (messageText) return messageText;
  if (errCode) return errCode;
  return null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Default filename for the dashboard CSV export.
 *
 * Embeds the status filter (or `all` when omitted) plus the current
 * UTC date so concurrent exports don't collide in the browser's
 * downloads folder. Sanitises the status value so a hostile filter
 * string can't inject path separators or quote chars into the
 * `Content-Disposition` header.
 */
function buildDefaultExportFilename(status: string | undefined): string {
  const sanitised = (status ?? 'all').replace(/[^a-z0-9_]/gi, '_').slice(0, 32);
  const date = new Date().toISOString().slice(0, 10);
  return `aggregator-dashboard-${sanitised}-${date}.csv`;
}
