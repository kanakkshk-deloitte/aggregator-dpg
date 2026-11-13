/**
 * Raya HTTP adapter for the campaign voice channel.
 *
 * `dispatch()` calls `POST /batch` to create the batch and validate each
 * contact. If at least one contact is accepted, it calls
 * `POST /batch/{batchId}/start` to start dialling. Other packages get an
 * instance only through {@link getVoiceProvider}.
 *
 * Calls use a timeout, retries with exponential backoff, and typed errors. On
 * a `429`, the wait comes from the body's `retry_after` (seconds), then the
 * `Retry-After` header.
 *
 * `providerResponse` is stored on `campaign_job.provider_response`. It is
 * built from a whitelist, never the raw payload, because Raya's
 * `errors[].value` and `data[]` contain PII.
 *
 * On a retry (`input.reuseExisting`), `dispatch()` reuses an existing batch
 * with the same name instead of creating a duplicate. It never reports more
 * contacts as `accepted` than Raya confirms.
 *
 * @module @aggregator-dpg/voice-provider
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
  VoiceProviderBase,
  brandCuratedProviderResponse,
  type CuratedProviderResponse,
  type VoiceDispatchInput,
  type VoiceDispatchResult,
} from './interface.js';

/**
 * Raya's `POST /batch` response shape (only the fields this adapter reads).
 * `errors[].value` and `data[]` contain PII and are never persisted.
 */
interface RayaCreateBatchResponse {
  status?: unknown;
  message?: unknown;
  batchId?: unknown;
  totalRows?: unknown;
  validRows?: unknown;
  invalidRows?: unknown;
  contactsInserted?: unknown;
  errors?: Array<{ row?: unknown; field?: unknown; value?: unknown; message?: unknown }>;
  data?: unknown;
}

/** Raya's `POST /batch/{id}/start` response shape (only the fields this adapter reads). */
interface RayaStartBatchResponse {
  id?: unknown;
  status?: unknown;
  total_contacts?: unknown;
  completed_contacts?: unknown;
  unanswered_contacts?: unknown;
  schedule?: unknown;
  max_retries?: unknown;
  concurrency?: unknown;
  retry_after_hrs?: unknown;
}

/**
 * Raya's `GET /batch` response shape (only the fields this adapter reads).
 * Used by {@link RayaVoiceProvider.findExistingBatch}.
 */
interface RayaListBatchesResponse {
  batches?: Array<{ id?: unknown; name?: unknown; agent_id?: unknown; total_contacts?: unknown }>;
}

/**
 * Whitelist of `POST /batch` response fields safe to persist. Excludes
 * `errors` and `data`, which contain PII.
 */
const CREATE_RESPONSE_PERSIST_KEYS = [
  'status',
  'message',
  'totalRows',
  'validRows',
  'invalidRows',
  'batchId',
  'contactsInserted',
] as const satisfies readonly (keyof RayaCreateBatchResponse)[];

/** Whitelist of `POST /batch/{id}/start` response fields safe to persist. */
const START_RESPONSE_PERSIST_KEYS = [
  'id',
  'status',
  'total_contacts',
  'completed_contacts',
  'unanswered_contacts',
  'schedule',
  'max_retries',
  'concurrency',
  'retry_after_hrs',
] as const satisfies readonly (keyof RayaStartBatchResponse)[];

/**
 * Reduces the raw `POST /batch` response to the persistence whitelist.
 *
 * @param payload - The raw parsed create-response body.
 * @returns Only the whitelisted fields present on `payload`, branded {@link CuratedProviderResponse}.
 */
function curateCreateResponse(payload: RayaCreateBatchResponse): CuratedProviderResponse {
  const out: Record<string, unknown> = {};
  for (const key of CREATE_RESPONSE_PERSIST_KEYS) {
    if (payload[key] !== undefined) out[key] = payload[key];
  }
  return brandCuratedProviderResponse(out);
}

/**
 * Reduces the raw `POST /batch/{id}/start` response to the persistence
 * whitelist.
 *
 * @param payload - The raw parsed start-response body.
 * @returns The whitelisted fields, or `{}` if `payload` is not an object.
 */
function curateStartResponse(payload: unknown): CuratedProviderResponse {
  const out: Record<string, unknown> = {};
  if (payload !== null && typeof payload === 'object') {
    const record = payload as RayaStartBatchResponse;
    for (const key of START_RESPONSE_PERSIST_KEYS) {
      if (record[key] !== undefined) out[key] = record[key];
    }
  }
  return brandCuratedProviderResponse(out);
}

/** Configuration for {@link RayaVoiceProvider}. */
export interface RayaVoiceProviderOptions {
  /** Base URL of the Raya API, e.g. `https://raya.example.com/api`. No trailing slash required. */
  baseUrl: string;
  /** Raya API key, sent as `X-API-Key` on every request. */
  apiKey: string;
  /** Optional per-attempt request timeout in ms; off by default. */
  timeoutMs?: number;
  /**
   * Max total attempts per HTTP call (create or start) before giving up.
   * Default `3`. Retries transport errors, timeouts, `429` and `5xx`; other
   * `4xx` are not retried.
   */
  maxAttempts?: number;
  /** Rate-limit gate awaited before every call (see `acquireRayaSlot`). */
  acquireSlot: () => Promise<void>;
  /** Optional override; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Sleep used for retry backoff. Defaults to `setTimeout`. Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export class RayaVoiceProvider extends VoiceProviderBase {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number | undefined;
  private readonly maxAttempts: number;
  private readonly acquireSlot: () => Promise<void>;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: RayaVoiceProviderOptions) {
    super();
    if (!opts.baseUrl) throw new Error('RayaVoiceProvider requires baseUrl');
    if (!opts.apiKey) throw new Error('RayaVoiceProvider requires apiKey');
    if (!opts.acquireSlot) throw new Error('RayaVoiceProvider requires acquireSlot');
    this.baseUrl = stripTrailingSlashes(opts.baseUrl);
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.acquireSlot = opts.acquireSlot;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /**
   * Creates a Raya batch from `input.contacts`, then starts it.
   *
   * If no contact is accepted, start is skipped and `providerResponse.start`
   * is `null`.
   *
   * When `input.reuseExisting` is true, it first looks for a batch with the
   * same `input.batchName`. A match is reused and create is skipped, so a
   * retry after a failed start does not create a duplicate batch. The lookup
   * is skipped on a first attempt, where no such batch can exist.
   *
   * @param input - The batch definition and the `reuseExisting` retry hint.
   * @returns The batch reference and per-contact outcome, or Err if create failed.
   */
  override async dispatch(
    input: VoiceDispatchInput,
  ): Promise<Result<VoiceDispatchResult, BaseError>> {
    const existing = input.reuseExisting
      ? await this.findExistingBatch(input.agentRef, input.batchName)
      : undefined;

    let providerBatchRef: string;
    let accepted: string[];
    let rejected: { ref: string; error: string }[];
    let createResponse: CuratedProviderResponse;

    if (existing) {
      providerBatchRef = String(existing.batchId);
      const demoted: { ref: string; error: string }[] = [];
      // Only `total_contacts` is known for a reused batch. Reject any
      // contacts beyond that count.
      accepted = demoteExcess(
        input.contacts.map((c) => c.ref),
        existing.totalContacts,
        'raya_batch_reused_short_count',
        demoted,
      );
      rejected = demoted;
      createResponse = brandCuratedProviderResponse({
        status: 'reused',
        message: 'existing batch reused after a transient start-call retry',
        batchId: existing.batchId,
        contactsInserted: existing.totalContacts,
      });
    } else {
      await this.acquireSlot();
      const createResult = await this.request<RayaCreateBatchResponse>('POST', '/batch', {
        agent_id: input.agentRef,
        batch_name: input.batchName,
        contacts: input.contacts.map((c) => ({
          contact_name: c.name,
          contact_phone: c.phone,
          ...(c.countryCode ? { country_code: c.countryCode } : {}),
          ref: c.ref,
          ...c.variables,
        })),
      });
      if (!createResult.success) return err(createResult.error);
      const createPayload = createResult.value;

      if (typeof createPayload.batchId !== 'number') {
        return err(
          new UpstreamError('raya batch create returned unexpected payload', {
            code: 'RAYA_BAD_RESPONSE',
            details: { payload: createPayload },
          }),
        );
      }
      providerBatchRef = String(createPayload.batchId);
      ({ accepted, rejected } = this.splitAcceptedRejected(input, createPayload));
      createResponse = curateCreateResponse(createPayload);
    }

    if (accepted.length === 0) {
      return ok({
        providerBatchRef,
        accepted,
        rejected,
        providerResponse: { create: createResponse, start: null },
      });
    }

    // Send the caller's startOptions as given, without defaults.
    await this.acquireSlot();
    const startBody: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input.startOptions)) {
      if (value !== undefined) startBody[key] = value;
    }
    const startResult = await this.request<unknown>(
      'POST',
      `/batch/${providerBatchRef}/start`,
      startBody,
    );
    if (!startResult.success) return err(startResult.error);

    return ok({
      providerBatchRef,
      accepted,
      rejected,
      providerResponse: {
        create: createResponse,
        start: curateStartResponse(startResult.value),
      },
    });
  }

  /**
   * Finds an existing batch with this name for this agent.
   *
   * Lists the newest 100 batches for the agent and matches the name exactly.
   * A failed lookup is treated as "not found".
   *
   * @param agentRef - The agent this batch belongs to.
   * @param batchName - The batch name (`campaign-{job.id}`) to match.
   * @returns The batch id and contact count, or `undefined` if not found.
   */
  private async findExistingBatch(
    agentRef: string,
    batchName: string,
  ): Promise<{ batchId: number; totalContacts: number } | undefined> {
    await this.acquireSlot();
    const result = await this.request<RayaListBatchesResponse>(
      'GET',
      `/batch?agent_id=${encodeURIComponent(agentRef)}&limit=100&sort=desc`,
      undefined,
    );
    if (!result.success) return undefined;
    const batches = Array.isArray(result.value.batches) ? result.value.batches : [];
    // The server already filters by `agent_id`; check it again here.
    const match = batches.find((b) => b.name === batchName && b.agent_id === agentRef);
    if (!match || typeof match.id !== 'number') return undefined;
    const totalContacts = typeof match.total_contacts === 'number' ? match.total_contacts : 0;
    return { batchId: match.id, totalContacts };
  }

  /**
   * Splits contacts into accepted and rejected from Raya's create response.
   *
   * Maps each 1-based `errors[].row` to its contact. Never reports more
   * accepted contacts than Raya confirms:
   *
   *   1. A duplicate row is counted once.
   *   2. For each error with no usable `row`, one contact from the end of the
   *      accepted list is rejected with `raya_unmapped_rejection`.
   *   3. Contacts beyond `contactsInserted` (or `validRows`) are rejected with
   *      `raya_short_count`.
   *
   * @param input - The dispatch input whose `contacts` order the rows index into.
   * @param payload - Raya's create-response payload (`errors`, `contactsInserted`, `validRows`).
   * @returns The accepted vs. rejected contact refs.
   */
  private splitAcceptedRejected(
    input: VoiceDispatchInput,
    payload: RayaCreateBatchResponse,
  ): { accepted: string[]; rejected: { ref: string; error: string }[] } {
    const rejectedRefs = new Set<string>();
    const rejected: { ref: string; error: string }[] = [];
    const errors = Array.isArray(payload.errors) ? payload.errors : [];
    let unmappedCount = 0;
    for (const e of errors) {
      const row = typeof e.row === 'number' ? e.row : undefined;
      if (row === undefined || row < 1 || row > input.contacts.length) {
        unmappedCount += 1;
        continue;
      }
      const contact = input.contacts[row - 1];
      if (!contact || rejectedRefs.has(contact.ref)) continue;
      rejectedRefs.add(contact.ref);
      rejected.push({ ref: contact.ref, error: resolveRejectionReason(e) });
    }

    let accepted = input.contacts.map((c) => c.ref).filter((ref) => !rejectedRefs.has(ref));

    if (unmappedCount > 0) {
      accepted = demoteExcess(
        accepted,
        accepted.length - unmappedCount,
        'raya_unmapped_rejection',
        rejected,
      );
    }

    const declaredAccepted = firstFiniteNumber(payload.contactsInserted, payload.validRows);
    if (declaredAccepted !== undefined) {
      accepted = demoteExcess(accepted, declaredAccepted, 'raya_short_count', rejected);
    }

    return { accepted, rejected };
  }

  /**
   * Performs one Raya API call with a per-attempt timeout and retries.
   *
   * Retries transport errors, timeouts, `429` and `5xx`, up to
   * {@link maxAttempts} tries. A `429` waits for Raya's signalled delay when
   * given (see {@link resolveRetryAfterMs}). A `401` returns `AuthError` and
   * other `4xx` return `ValidationError`, without retry. Exhausted retries
   * return `UpstreamError`.
   *
   * @param method - HTTP method.
   * @param path - Path appended to `baseUrl` (leading slash).
   * @param body - JSON request body.
   * @returns ok(parsed JSON body) on 2xx; err(BaseError) otherwise.
   */
  private async request<T>(
    method: string,
    path: string,
    body: unknown,
  ): Promise<Result<T, BaseError>> {
    const url = `${this.baseUrl}${path}`;
    let attemptsMade = 0;

    for (;;) {
      attemptsMade += 1;
      const attempt = await this.attemptFetch(method, url, body);

      if (!attempt.ok) {
        if (attemptsMade < this.maxAttempts) {
          await this.backoff(attemptsMade);
          continue;
        }
        return err(transportFailureError(path, this.timeoutMs, attempt));
      }

      const outcome = await classifyResponse<T>(attempt.res, path);
      if (outcome.kind === 'result') return outcome.result;

      // 429 or 5xx — transient, retry within budget.
      if (attemptsMade < this.maxAttempts) {
        await this.backoff(attemptsMade, outcome.retryAfterMs);
        continue;
      }
      return err(await exhaustedRetryError(path, attempt.res));
    }
  }

  /**
   * Makes one HTTP attempt with the per-attempt timeout.
   *
   * @param method - HTTP method.
   * @param url - Full request URL.
   * @param body - JSON request body.
   * @returns The `Response`, or the transport failure and whether it timed out.
   */
  private async attemptFetch(method: string, url: string, body: unknown): Promise<FetchAttempt> {
    const controller = this.timeoutMs ? new AbortController() : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : undefined;
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers: { 'content-type': 'application/json', 'X-API-Key': this.apiKey },
        body: JSON.stringify(body),
        ...(controller ? { signal: controller.signal } : {}),
      });
      return { ok: true, res };
    } catch (e) {
      const cause = e as Error;
      return { ok: false, aborted: cause.name === 'AbortError', cause };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Sleeps before the next retry. Uses `overrideMs` when given, otherwise
   * `200ms * 2^(attempt-1)`.
   */
  private backoff(attempt: number, overrideMs?: number): Promise<void> {
    const ms = overrideMs ?? 200 * 2 ** (attempt - 1);
    if (ms <= 0) return Promise.resolve();
    return this.sleep(ms);
  }
}

/** Result of one raw `fetch` attempt inside {@link RayaVoiceProvider.request}'s retry loop. */
type FetchAttempt = { ok: true; res: Response } | { ok: false; aborted: boolean; cause: Error };

/** Result of {@link classifyResponse}: a final result, or retry. */
type ResponseOutcome<T> =
  { kind: 'result'; result: Result<T, BaseError> } | { kind: 'retry'; retryAfterMs?: number };

/**
 * Classifies one Raya response.
 *
 * A 2xx parses to `ok`, a `401` to `AuthError`, and other `4xx` to
 * `ValidationError`. A `429` or `5xx` returns `{ kind: 'retry' }`, with the
 * `429` wait if given.
 *
 * @param res - The response to classify.
 * @param path - The request path, for error messages.
 * @returns Either the terminal `Result` to return, or a retry signal.
 */
async function classifyResponse<T>(res: Response, path: string): Promise<ResponseOutcome<T>> {
  if (res.ok) {
    try {
      return { kind: 'result', result: ok((await res.json()) as T) };
    } catch (e) {
      return {
        kind: 'result',
        result: err(
          new UpstreamError('raya returned a malformed JSON body', {
            cause: e,
            code: 'RAYA_BAD_RESPONSE',
          }),
        ),
      };
    }
  }

  if (res.status === 401) {
    const bodyText = await safeReadText(res);
    return {
      kind: 'result',
      result: err(
        new AuthError(`raya ${path} returned 401`, {
          code: 'RAYA_UNAUTHORIZED',
          details: { status: res.status, body: bodyText },
        }),
      ),
    };
  }

  if (res.status !== 429 && res.status < 500) {
    const bodyText = await safeReadText(res);
    return {
      kind: 'result',
      result: err(
        new ValidationError(`raya ${path} returned ${res.status}`, {
          code: 'RAYA_BAD_REQUEST',
          details: { status: res.status, body: bodyText },
        }),
      ),
    };
  }

  // 429 or 5xx: the caller decides whether to retry.
  const retryAfterMs = res.status === 429 ? await resolveRetryAfterMs(res) : undefined;
  return retryAfterMs !== undefined ? { kind: 'retry', retryAfterMs } : { kind: 'retry' };
}

/**
 * Builds the `UpstreamError` for a failed fetch after the last retry.
 *
 * @param path - The request path, for the error message.
 * @param timeoutMs - The configured per-attempt timeout, for the message text.
 * @param attempt - The failed attempt's classification.
 */
function transportFailureError(
  path: string,
  timeoutMs: number | undefined,
  attempt: { aborted: boolean; cause: Error },
): UpstreamError {
  return new UpstreamError(
    attempt.aborted
      ? `raya ${path} timed out after ${timeoutMs}ms`
      : `raya ${path} transport failure: ${attempt.cause.message}`,
    { cause: attempt.cause, code: attempt.aborted ? 'RAYA_TIMEOUT' : 'RAYA_TRANSPORT_FAILED' },
  );
}

/**
 * Builds the `UpstreamError` for a `429` or `5xx` after the last retry.
 *
 * @param path - The request path, for the error message.
 * @param res - The final failed response.
 */
async function exhaustedRetryError(path: string, res: Response): Promise<UpstreamError> {
  const bodyText = await safeReadText(res);
  return new UpstreamError(`raya ${path} returned ${res.status}`, {
    code: 'RAYA_UPSTREAM_ERROR',
    details: { status: res.status, body: bodyText },
  });
}

/**
 * Returns the rejection reason for one `errors[]` entry: `message`, then
 * `field`, then `'rejected'`.
 *
 * @param e - One entry from Raya's create-response `errors` array.
 * @returns The reason string to store for the rejected contact.
 */
function resolveRejectionReason(e: { field?: unknown; message?: unknown }): string {
  if (typeof e.message === 'string') return e.message;
  if (typeof e.field === 'string') return e.field;
  return 'rejected';
}

/**
 * Moves refs beyond `allowedCount` from `acceptedRefs` into `rejected`.
 *
 * Mutates `rejected` in place.
 *
 * @param acceptedRefs - The currently-accepted contact refs, in dispatch order.
 * @param allowedCount - The maximum count that may legitimately stay accepted.
 * @param reason - The rejection reason recorded for any demoted ref.
 * @param rejected - Rejected-list accumulator; demoted refs are pushed here.
 * @returns The (possibly shortened) accepted list.
 */
function demoteExcess(
  acceptedRefs: string[],
  allowedCount: number,
  reason: string,
  rejected: { ref: string; error: string }[],
): string[] {
  const safeAllowed = Math.max(0, allowedCount);
  if (acceptedRefs.length <= safeAllowed) return acceptedRefs;
  for (const ref of acceptedRefs.slice(safeAllowed)) {
    rejected.push({ ref, error: reason });
  }
  return acceptedRefs.slice(0, safeAllowed);
}

/**
 * Returns the first finite number among `values`, or `undefined`.
 *
 * @param values - Candidate values, tried in order.
 */
function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

/**
 * Default `setTimeout`-based sleep, used when no `sleep` is injected.
 *
 * @param ms - Milliseconds to wait.
 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolves how long to wait before retrying a `429`, in ms.
 *
 * Reads the body's `retry_after` (seconds), then the `Retry-After` header.
 * Raya sends the body field.
 *
 * Consumes the response body. Do not read it again.
 *
 * @param res - The `429` response.
 * @returns The wait in ms, or `undefined` to use the computed backoff.
 */
async function resolveRetryAfterMs(res: Response): Promise<number | undefined> {
  try {
    const bodyText = await res.text();
    if (bodyText) {
      const parsed = JSON.parse(bodyText) as Record<string, unknown>;
      const bodySeconds = parsed?.['retry_after'];
      if (typeof bodySeconds === 'number' && Number.isFinite(bodySeconds) && bodySeconds >= 0) {
        return bodySeconds * 1000;
      }
    }
  } catch {
    // Non-JSON or unreadable body: try the header.
  }
  const header = res.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return seconds * 1000;
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
