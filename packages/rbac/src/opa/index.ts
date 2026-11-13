/**
 * OPA-backed decision engine (`@aggregator-dpg/rbac`).
 *
 * Asks the OPA sidecar under `{baseUrl}/v1/data/rbac/`: `decision` for one
 * capability, `capabilities` for the list the portal shows. Every call has a
 * timeout and one retry with backoff on transient failures. Any failure is
 * returned as an `UpstreamError`, which callers treat as a deny.
 *
 * @module @aggregator-dpg/rbac/opa
 */

import { z } from 'zod';
import { ok, err } from '@aggregator-dpg/shared-primitives/result';
import { UpstreamError } from '@aggregator-dpg/shared-primitives/errors';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import { AuthorizerBase, CapabilitySchema, DecisionSchema } from '../interface.js';
import type { Capability, CapabilityListInput, Decision, DecisionInput } from '../interface.js';
import { compareCodeUnits } from '../order.js';

/** Settings for {@link OpaAuthorizer}. */
export interface OpaAuthorizerOptions {
  /** Sidecar base URL, e.g. `http://localhost:8181`. */
  baseUrl: string;
  /** Per-attempt timeout in milliseconds. */
  timeoutMs: number;
  /** Retries after the first attempt, for transient failures. */
  retries: number;
  /** Base backoff in milliseconds; doubles per retry. */
  backoffMs: number;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

const DECISION_PATH = '/v1/data/rbac/decision';
const CAPABILITIES_PATH = '/v1/data/rbac/capabilities';
const CapabilityListSchema = z.array(CapabilitySchema);

/** Whether a failed attempt is worth retrying. */
function isTransient(status: number | null): boolean {
  return status === null || status === 429 || status >= 500;
}

/** Decision engine that queries the OPA sidecar. */
export class OpaAuthorizer extends AuthorizerBase {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  /**
   * Creates an engine bound to one sidecar.
   *
   * @param options - URL, timeout and retry settings.
   */
  constructor(private readonly options: OpaAuthorizerOptions) {
    super();
    this.base = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Answers one access question through OPA.
   *
   * @param input - The access question.
   * @returns Ok with the decision; Err `OPA_UNAVAILABLE`, `OPA_REJECTED` or `OPA_BAD_RESPONSE`.
   */
  async decide(input: DecisionInput): Promise<Result<Decision, BaseError>> {
    return this.query(DECISION_PATH, input, DecisionSchema);
  }

  /**
   * Lists the held candidate capabilities through OPA, in one call.
   *
   * @param input - The actor, the candidates and the current time.
   * @returns Ok with the held capabilities (sorted); the same errors as {@link decide}.
   */
  async listCapabilities(input: CapabilityListInput): Promise<Result<Capability[], BaseError>> {
    const res = await this.query(CAPABILITIES_PATH, input, CapabilityListSchema);
    return res.success ? ok([...res.value].sort(compareCodeUnits)) : res;
  }

  /** POSTs `{ input }` to a data path and validates `result` against `schema`. */
  private async query<T>(
    path: string,
    input: unknown,
    schema: z.ZodType<T>,
  ): Promise<Result<T, BaseError>> {
    const url = this.base + path;
    let lastStatus: number | null = null;
    let lastError = '';
    for (let attempt = 0; attempt <= this.options.retries; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, this.options.backoffMs * 2 ** (attempt - 1)));
      }
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ input }),
          signal: AbortSignal.timeout(this.options.timeoutMs),
        });
      } catch (e) {
        lastStatus = null;
        lastError = String(e);
        continue;
      }
      if (!res.ok) {
        lastStatus = res.status;
        lastError = `HTTP ${res.status}`;
        if (isTransient(res.status)) continue;
        return err(
          new UpstreamError('OPA rejected the request', {
            code: 'OPA_REJECTED',
            details: { status: res.status, path },
          }),
        );
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch (e) {
        return err(
          new UpstreamError('OPA returned invalid JSON', { code: 'OPA_BAD_RESPONSE', cause: e }),
        );
      }
      const parsed = schema.safeParse((body as { result?: unknown } | null)?.result);
      if (!parsed.success) {
        return err(
          new UpstreamError('OPA returned no result; is the rbac policy loaded?', {
            code: 'OPA_BAD_RESPONSE',
            details: { path },
          }),
        );
      }
      return ok(parsed.data);
    }
    return err(
      new UpstreamError('OPA is unavailable', {
        code: 'OPA_UNAVAILABLE',
        details: { status: lastStatus, error: lastError, attempts: this.options.retries + 1, path },
      }),
    );
  }
}
