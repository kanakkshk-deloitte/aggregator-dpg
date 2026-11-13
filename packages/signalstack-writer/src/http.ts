/**
 * Fetch-based SignalStackWriter used in production, in the signalstack-writer package.
 *
 * Any non-2xx response, network failure, or unexpected payload becomes an
 * UpstreamError. Methods never throw.
 *
 * Every request goes through {@link HttpSignalStackWriter.requestWithRetry},
 * which applies the per-attempt timeout and retries transport errors,
 * timeouts, `429`, and `5xx` with exponential backoff. Probe, aggregator
 * upsert, and the reads are idempotent. `onboard` is not: each call inserts a
 * new profile, so a retry after a request that did succeed can create a
 * duplicate (limited by the per-user cap).
 */

import {
  AuthError,
  UpstreamError,
  ValidationError,
} from '@aggregator-dpg/shared-primitives/errors';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import { err, ok } from '@aggregator-dpg/shared-primitives/result';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import { stripTrailingSlashes } from '@aggregator-dpg/shared-primitives/url';

import {
  SignalStackWriterBase,
  type SignalStackTokenProviderBase,
  type SignalStackAggregator,
  type SignalStackDashboardExport,
  type SignalStackDashboardExportQuery,
  type SignalStackDashboardPage,
  type SignalStackDashboardQuery,
  type SignalStackDecryptedProfiles,
  type SignalStackFetchDecryptedProfilesQuery,
  type SignalStackOnboardParticipantInput,
  type SignalStackOnboardParticipantResult,
  type SignalStackProbeUserInput,
  type SignalStackProbeUserResult,
  type SignalStackUpsertAggregatorInput,
} from './interface.js';

export interface HttpSignalStackWriterConfig {
  /** Base URL of the signalstack API, e.g. `http://localhost:2743`. No trailing slash. */
  baseUrl: string;
  /**
   * Admin API key issued by signalstack. Sent as `x-api-key`.
   * Set exactly one of this or {@link tokenProvider}.
   */
  apiKey?: string;
  /**
   * Client-credentials token provider. When set, requests send
   * `Authorization: Bearer <token>` instead of `x-api-key`.
   * Set exactly one of this or {@link apiKey}.
   */
  tokenProvider?: SignalStackTokenProviderBase;
  /**
   * Platform-wide signalstack organisation id, sent as `x-acting-org-id` on
   * `POST /api/v1/admin/aggregator/upsert`. Required for that call only.
   */
  actingOrgId?: string;
  /** Optional fetch override; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Optional per-attempt request timeout in ms; off by default. */
  timeoutMs?: number;
  /**
   * Max retries for transport errors, timeouts, `429`, and `5xx`. Default `2`
   * (3 attempts in total). `0` disables retries. Other `4xx` are never retried.
   */
  maxRetries?: number;
  /**
   * Base backoff in ms between retries; doubles each attempt. Default `200`.
   * `0` removes the delay.
   */
  retryBaseMs?: number;
}

export class HttpSignalStackWriter extends SignalStackWriterBase {
  private readonly baseUrl: string;
  private readonly endpoint: string;
  private readonly apiKey: string | undefined;
  private readonly tokenProvider: SignalStackTokenProviderBase | undefined;
  /**
   * Signalstack organisation id sent as `x-acting-org-id` on the aggregator
   * upsert call. When unset, the upsert returns `SIGNALSTACK_CONFIG_MISSING`.
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
    if (!config.apiKey && !config.tokenProvider) {
      throw new Error('HttpSignalStackWriter requires either apiKey or tokenProvider');
    }
    if (config.apiKey && config.tokenProvider) {
      throw new Error(
        'HttpSignalStackWriter accepts only one of apiKey or tokenProvider, not both',
      );
    }
    this.baseUrl = stripTrailingSlashes(config.baseUrl);
    this.endpoint = `${this.baseUrl}/api/v1/admin/participant`;
    this.apiKey = config.apiKey;
    this.tokenProvider = config.tokenProvider;
    this.actingOrgId = config.actingOrgId;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs;
    this.maxRetries = config.maxRetries ?? 2;
    this.retryBaseMs = config.retryBaseMs ?? 200;
  }

  /**
   * Fetches with a per-attempt timeout and exponential-backoff retry.
   *
   * Retries transport errors, timeouts, `429`, and `5xx`. Other `4xx` are
   * returned at once. When retries run out, the last error is re-thrown or the
   * last `Response` is returned.
   *
   * With a token provider, a `401` gets one extra attempt with a new token.
   * This attempt does not use the retry budget and has no backoff. The
   * `x-api-key` path has no such retry.
   *
   * @param url - Absolute request URL.
   * @param init - Fetch init; the `signal` is supplied per attempt.
   * @returns The final `Response` (success, non-retryable, or exhausted).
   * @throws The last transport/timeout error when every attempt threw.
   */
  private async requestWithRetry(url: string, init: RequestInit): Promise<Response> {
    let currentInit = init;
    let remintDone = false;
    // Counts retries only; the 401 token refresh does not use the budget.
    let attempt = 0;
    for (;;) {
      const controller = this.timeoutMs ? new AbortController() : undefined;
      const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : undefined;
      try {
        const res = await this.fetchImpl(url, {
          ...currentInit,
          ...(controller ? { signal: controller.signal } : {}),
        });

        if (res.status === 401 && this.tokenProvider && !remintDone) {
          remintDone = true;
          this.tokenProvider.invalidate();
          const refreshed = await this.tokenProvider.getToken();
          // If the refresh fails, return the original 401 (SIGNALSTACK_FORBIDDEN).
          if (refreshed.success) {
            currentInit = {
              ...currentInit,
              headers: {
                ...(currentInit.headers as Record<string, string>),
                authorization: `Bearer ${refreshed.value}`,
              },
            };
            continue;
          }
          return res;
        }

        if (attempt < this.maxRetries && (res.status === 429 || res.status >= 500)) {
          await this.backoff(attempt);
          attempt += 1;
          continue;
        }
        return res;
      } catch (e) {
        if (attempt < this.maxRetries) {
          await this.backoff(attempt);
          attempt += 1;
          continue;
        }
        throw e;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    // Unreachable: the loop always returns or throws.
  }

  /** Sleeps for `retryBaseMs * 2^attempt` ms before the next retry. */
  private backoff(attempt: number): Promise<void> {
    const ms = this.retryBaseMs * 2 ** attempt;
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Builds the auth and content-type headers for a request.
   *
   * Uses `Authorization: Bearer <token>` when a
   * {@link SignalStackTokenProviderBase} is set, else `x-api-key`. The token is
   * requested on every call; the provider handles caching. Retries reuse the
   * same headers.
   *
   * @returns ok(headers), or the token provider's error.
   */
  private async buildHeaders(): Promise<Result<Record<string, string>, BaseError>> {
    if (this.tokenProvider) {
      const tokenResult = await this.tokenProvider.getToken();
      if (!tokenResult.success) return err(tokenResult.error);
      return ok({
        'content-type': 'application/json',
        authorization: `Bearer ${tokenResult.value}`,
      });
    }
    return ok({
      'content-type': 'application/json',
      'x-api-key': this.apiKey as string,
    });
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
    // Consent goes only in `compliance`; `terms_accepted`/`privacy_accepted` are never sent.
    if (input.compliance && input.compliance.length > 0) body.compliance = input.compliance;
    if (typeof input.age === 'number') body.age = input.age;
    // `profile` is sent as `item_state`. For account_only it is omitted, so
    // signals creates only the user row.
    if (submitMode !== 'account_only') {
      body.item_state = input.profile;
      // Omitted when empty so signalstack geocodes the address in item_state.
      if (input.item_locations && input.item_locations.length > 0) {
        body.item_locations = input.item_locations;
      }
    }
    // Omit empty email/phone; signalstack rejects null for these fields with 400.
    if (input.phoneNumber) body.phone_number = input.phoneNumber;
    if (input.email) body.email = input.email;

    const headersResult = await this.buildHeaders();
    if (!headersResult.success) return err(headersResult.error);
    const headers = {
      ...headersResult.value,
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
        // Include signalstack's message when present; callers show it in errors.csv.
        const message = upstreamMsg
          ? `signalstack onboard returned ${res.status}: ${upstreamMsg}`
          : `signalstack onboard returned ${res.status}`;
        // Give the per-user profile cap (409) and an out-of-country coordinate
        // (400) their own codes so callers treat them as data errors.
        const code = this.onboardErrorCode(res.status, upstreamCode);
        // `signalsMessage` is safe to show end users; `message` is for operators.
        const signalsMessage = extractUpstreamMessageText(bodyText);
        // Signals' per-field errors, so callers can point at the bad input.
        const signalsFields = extractUpstreamFields(bodyText);
        return err(
          new UpstreamError(message, {
            code,
            details: {
              status: res.status,
              body: bodyText,
              ...(signalsMessage ? { signalsMessage } : {}),
              ...(upstreamCode ? { upstreamCode } : {}),
              ...(signalsFields ? { signalsFields } : {}),
            },
          }),
        );
      }

      // Response: { user_id, user_existed, onboarded_at, items: [{ item_id, lifecycle_status?, ... }] }
      // `profile_item_id` is the item matching network/domain/type, else the first item.
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

      // account_only: empty `items` is expected. A returning own user is a
      // success, not `already_registered`; only an explicit `owned_elsewhere`
      // marks a foreign user. Must run before the with-item check below.
      if (submitMode === 'account_only') {
        return ok({
          user_id: raw.user_id,
          profile_item_id: '',
          onboarded_at: typeof raw.onboarded_at === 'string' ? raw.onboarded_at : '',
          already_registered: false,
          owned_elsewhere: ownedElsewhereSignal,
        });
      }
      // with_item: an existing user with no items belongs to another
      // aggregator. Return it as owned_elsewhere so the caller records `skipped`.
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

  /**
   * Calls `POST /api/v1/admin/aggregator/upsert` with the configured
   * `x-acting-org-id`. Idempotent on `external_id`, so it is safe to retry.
   *
   * @param input - external_id (coordinator `users.id`), display name, slug, optional metadata.
   * @returns ok(SignalStackAggregator) on 2xx with a non-empty `org_id`; err(BaseError) otherwise.
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

    const headersResult = await this.buildHeaders();
    if (!headersResult.success) return err(headersResult.error);
    const headers = {
      ...headersResult.value,
      'x-acting-org-id': this.actingOrgId,
      ...(input.requestId ? { 'x-request-id': input.requestId } : {}),
    };

    try {
      const res = await this.requestWithRetry(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      return await this.parseUpsertResponse(res);
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

  /** Maps a signalstack aggregator-upsert response to a Result. */
  private async parseUpsertResponse(
    res: Response,
  ): Promise<Result<SignalStackAggregator, BaseError>> {
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
    const payload = (await res.json()) as unknown;
    if (!hasValidAggregatorOrgId(payload)) {
      return err(
        new UpstreamError('signalstack aggregator upsert returned unexpected payload', {
          code: 'SIGNALSTACK_BAD_RESPONSE',
          details: { payload },
        }),
      );
    }
    return ok(payload);
  }

  /**
   * Fetches the aggregator dashboard payload from signalstack.
   *
   * Sends `page`, `limit`, `status`, `lifecycle`, and `refresh`. `domain` is
   * not sent; signalstack does not accept it.
   *
   * @param query - actingOrgId plus optional pagination/status/domain.
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
    const qs = params.toString();
    const url = `${this.baseUrl}/api/v1/aggregator/dashboard${qs ? `?${qs}` : ''}`;

    const headersResult = await this.buildHeaders();
    if (!headersResult.success) return err(headersResult.error);
    const headers = {
      ...headersResult.value,
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
   * Sends `status` and `refresh` only; `domain` is not sent. Requests
   * `accept: text/csv` and returns the raw CSV body. The default filename has
   * the status filter and the UTC date.
   *
   * @param query - actingOrgId plus optional status/domain.
   * @returns ok(SignalStackDashboardExport) on 2xx; err(BaseError) otherwise.
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

    const headersResult = await this.buildHeaders();
    if (!headersResult.success) return err(headersResult.error);
    const headers = {
      ...headersResult.value,
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
    const headersResult = await this.buildHeaders();
    if (!headersResult.success) return err(headersResult.error);
    const headers = {
      ...headersResult.value,
      'x-acting-org-id': query.actingOrgId,
      ...(query.requestId ? { 'x-request-id': query.requestId } : {}),
    };

    try {
      const res = await this.requestWithRetry(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          item_ids: query.itemIds,
          ...(query.fields !== undefined ? { fields: query.fields } : {}),
          ...(query.contact !== undefined ? { contact: query.contact } : {}),
        }),
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
   * Read-only identity probe via `GET /admin/participant`. Safe to retry.
   *
   * Signalstack returns `{ user_id, items }`, with `items` limited to the
   * acting org. The result is mapped to {@link SignalStackProbeUserResult}:
   *   - `user_id` null             → new identity
   *   - `user_id` + owned items     → own user (+ lifecycle summary)
   *   - `user_id` + no owned items  → user exists under a different aggregator
   *
   * @param input - actingOrgId, email and/or phoneNumber, network, and domain.
   * @returns ok(SignalStackProbeUserResult) on 2xx; err(BaseError) otherwise.
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

    // Email and phone are sent in the query string. The signals ingress must
    // keep `/admin/participant` query strings out of its access log.
    const params = new URLSearchParams();
    if (input.email) params.set('email', input.email);
    if (input.phoneNumber) params.set('phone_number', input.phoneNumber);
    const url = `${this.endpoint}?${params.toString()}`;

    const headersResult = await this.buildHeaders();
    if (!headersResult.success) return err(headersResult.error);
    const headers = {
      ...headersResult.value,
      'x-acting-org-id': input.actingOrgId,
      ...(input.requestId ? { 'x-request-id': input.requestId } : {}),
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

      // Response: { user_id: string | null, items: [...] }. `items` holds only
      // this aggregator's items, across all domains.
      const raw = (await res.json()) as {
        user_id?: unknown;
        items?: unknown;
      };
      if (!raw || typeof raw !== 'object') {
        return err(
          new UpstreamError('signalstack probe returned unexpected payload', {
            code: 'SIGNALSTACK_BAD_RESPONSE',
            details: { payload: raw },
          }),
        );
      }

      const userId = typeof raw.user_id === 'string' && raw.user_id.length > 0 ? raw.user_id : null;

      // No matching identity: a new user.
      if (!userId) {
        return ok({
          user_exists: false,
          owned_elsewhere: false,
          lifecycle_summary: null,
        });
      }

      // `items` is required; fail instead of treating it as owned elsewhere.
      if (!Array.isArray(raw.items)) {
        return err(
          new UpstreamError('signalstack probe response missing items array', {
            code: 'SIGNALSTACK_BAD_RESPONSE',
            details: { payload: raw },
          }),
        );
      }
      const items = raw.items as Array<{
        item_id?: unknown;
        item_network?: unknown;
        item_domain?: unknown;
        lifecycle_status?: unknown;
      }>;

      // No items owned by this aggregator: owned elsewhere.
      if (items.length === 0) {
        return ok({
          user_exists: true,
          owned_elsewhere: true,
          lifecycle_summary: null,
        });
      }

      // The primary item must match the probed network and domain, since
      // `items` can include other domains.
      const domainItem = items.find(
        (it) => it.item_domain === input.domain && it.item_network === input.network,
      );

      // Own user with no item in this domain: no lifecycle summary.
      if (!domainItem) {
        return ok({
          user_exists: true,
          owned_elsewhere: false,
          lifecycle_summary: null,
        });
      }

      const itemId = typeof domainItem.item_id === 'string' ? domainItem.item_id : '';
      if (!itemId) {
        return err(
          new UpstreamError('signalstack probe primary item missing item_id', {
            code: 'SIGNALSTACK_BAD_RESPONSE',
            details: { payload: raw },
          }),
        );
      }

      // lifecycle_status mapping:
      //   - absent/empty      → 'live' (older signals builds omit it).
      //   - draft/live/paused → used as-is.
      //   - retired           → no summary; not resumable.
      //   - anything else     → SIGNALSTACK_BAD_RESPONSE.
      const rawLifecycle = domainItem.lifecycle_status;
      if (rawLifecycle === 'retired') {
        return ok({
          user_exists: true,
          owned_elsewhere: false,
          lifecycle_summary: null,
        });
      }
      let lifecycleStatus: 'draft' | 'live' | 'paused';
      if (rawLifecycle === undefined || rawLifecycle === null || rawLifecycle === '') {
        lifecycleStatus = 'live';
      } else if (rawLifecycle === 'draft' || rawLifecycle === 'live' || rawLifecycle === 'paused') {
        lifecycleStatus = rawLifecycle;
      } else {
        return err(
          new UpstreamError(
            `signalstack probe returned unknown lifecycle_status: ${
              typeof rawLifecycle === 'string' ? rawLifecycle : JSON.stringify(rawLifecycle)
            }`,
            { code: 'SIGNALSTACK_BAD_RESPONSE', details: { payload: raw } },
          ),
        );
      }
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

  private guardInput(input: SignalStackOnboardParticipantInput): BaseError | null {
    // Input errors are ValidationError with code SIGNALSTACK_INPUT_INVALID.
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

  /**
   * Picks the error code for a rejected onboard.
   *
   * The per-user profile cap and an out-of-country coordinate get their own
   * codes; anything else uses the status-based code.
   */
  private onboardErrorCode(status: number, upstreamCode: string | null): string {
    if (status === 409 && upstreamCode === 'PROFILE_LIMIT_REACHED') {
      return 'SIGNALSTACK_PROFILE_LIMIT_REACHED';
    }
    if (status === 400 && upstreamCode === 'LOCATION_OUTSIDE_COUNTRY') {
      return 'SIGNALSTACK_LOCATION_OUTSIDE_COUNTRY';
    }
    return this.codeForStatus(status);
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

/** Extracts signalstack's machine error code from a JSON error body, if any. */
function extractUpstreamCode(bodyText: string): string | null {
  if (!bodyText) return null;
  try {
    const obj = JSON.parse(bodyText) as Record<string, unknown>;
    // Fastify validation errors put the code in `code`; signals puts it in `error`.
    const c = obj?.['code'];
    if (typeof c === 'string' && /^[A-Z][A-Z0-9_]+$/.test(c)) return c;
    const e = obj?.['error'];
    if (typeof e === 'string') return e;
    if (isObject(e) && typeof e['code'] === 'string') return e['code'] as string;
  } catch {
    /* non-JSON body — no machine code */
  }
  return null;
}

/**
 * Extracts the per-field error map (`fields: { <field>: <message> }`) from a
 * JSON error body. Only string entries are kept.
 */
function extractUpstreamFields(bodyText: string): Record<string, string> | null {
  if (!bodyText) return null;
  try {
    const obj = JSON.parse(bodyText) as Record<string, unknown>;
    const f = obj['fields'];
    if (!isObject(f)) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(f)) if (typeof v === 'string') out[k] = v;
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Extracts the `message` from a JSON error body, without the `"<CODE>: "`
 * prefix that {@link extractUpstreamMessage} adds. Safe to show end users.
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

/**
 * Extracts a readable error string from a signalstack error body.
 *
 * Handles shapes like:
 *   { "error": "INVALID_ITEM_STATE", "message": "Invalid item_state: must be …" }
 *   { "statusCode": 400, "error": "Bad Request", "message": "body/x Invalid …" }
 *   { "error": { "message": "…" } }
 *
 * Returns `"<code>: <message>"` when both exist. A non-JSON body is returned
 * trimmed to 500 characters. Returns `null` when there is no usable text.
 */
function extractUpstreamMessage(bodyText: string): string | null {
  if (!bodyText) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
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

/** True when a signalstack response carries a usable aggregator `org_id`. */
function hasValidAggregatorOrgId(payload: unknown): payload is SignalStackAggregator {
  return isObject(payload) && typeof payload.org_id === 'string' && payload.org_id.length > 0;
}

/**
 * Default filename for the dashboard CSV export.
 *
 * Includes the status filter (or `all`) and the UTC date. The status is
 * sanitised so it cannot inject path separators or quotes into the
 * `Content-Disposition` header.
 */
function buildDefaultExportFilename(status: string | undefined): string {
  const sanitised = (status ?? 'all').replace(/[^a-z0-9_]/gi, '_').slice(0, 32);
  const date = new Date().toISOString().slice(0, 10);
  return `aggregator-dashboard-${sanitised}-${date}.csv`;
}
