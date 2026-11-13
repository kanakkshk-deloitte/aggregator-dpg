/**
 * Publishes the role catalogue to the OPA sidecar for the edge policy
 * (`@aggregator-dpg/api`, RBAC edge enforcement).
 *
 * The edge (Envoy + OPA, docs/rbac/rbac-edge-enforcement.md §3.3) expands a
 * token's `roles` claim to permissions itself, so OPA needs the catalogue the
 * API already holds in its role snapshot. The API writes it to
 * `data.catalogue` (read by `policy/rbac/edge.rego`) with the edge's mode.
 * OPA keeps data in memory only, so the API re-publishes on every catalogue
 * refresh tick, not only when the revision changes: a restarted sidecar is
 * filled again within one tick, and refuses capability routes until then.
 */

import { compareCodeUnits, type RoleIndex } from '@aggregator-dpg/rbac';
import { UpstreamError, type BaseError } from '@aggregator-dpg/shared-primitives/errors';
import { err, ok, type Result } from '@aggregator-dpg/shared-primitives/result';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { TEST_EDGE_FETCH_KEY, type EdgeFetchRecorder } from './edge-test-hook.js';

/** The edge's mode: `off` (nothing published), `log` (would-deny logged) or `enforce`. */
export type EdgeMode = 'off' | 'log' | 'enforce';

/** The document the edge policy reads as `data.catalogue`. */
export interface EdgeCatalogue {
  /** The edge's mode; the policy enforces when it is absent or unknown. */
  mode: Exclude<EdgeMode, 'off'>;
  /** The catalogue revision the roles were read at. */
  revision: string;
  /** Every role in the snapshot, by key, with its permissions sorted. */
  roles: Record<string, { permissions: string[] }>;
}

/** Where and how to reach the sidecar. */
export interface EdgePublishOptions {
  /** OPA base URL. */
  baseUrl: string;
  /** Per-attempt timeout in milliseconds. */
  timeoutMs: number;
  /** Retries after the first attempt, for transient failures. */
  retries: number;
  /** Base backoff in milliseconds; doubles per retry. */
  backoffMs: number;
  /** `fetch` to use; injectable for tests. */
  fetchImpl?: typeof fetch;
}

/** OPA's data path the edge policy reads. */
const CATALOGUE_PATH = '/v1/data/catalogue';

/**
 * Builds the published document from a role snapshot.
 *
 * @param roles - The role snapshot (built-in and, when enabled, custom roles).
 * @param revision - The catalogue revision the snapshot was read at.
 * @param mode - The edge's mode.
 * @returns The document, with role keys and permissions in a stable order.
 */
export function edgeCatalogue(
  roles: RoleIndex,
  revision: string,
  mode: Exclude<EdgeMode, 'off'>,
): EdgeCatalogue {
  const keys = [...roles.byKey.keys()].sort(compareCodeUnits);
  const out: EdgeCatalogue['roles'] = {};
  for (const key of keys) {
    const role = roles.byKey.get(key);
    if (role) out[key] = { permissions: [...role.permissions].sort(compareCodeUnits) };
  }
  return { mode, revision, roles: out };
}

/** The sidecar settings from config; under the unit-test setup, its recording fetch. */
function optionsFromConfig(): EdgePublishOptions {
  const test = (globalThis as Record<string, unknown>)[TEST_EDGE_FETCH_KEY] as
    EdgeFetchRecorder | undefined;
  return {
    baseUrl: config.OPA_URL,
    timeoutMs: config.OPA_TIMEOUT_MS,
    retries: config.OPA_RETRIES,
    backoffMs: config.OPA_BACKOFF_MS,
    ...(test ? { fetchImpl: test.fetch } : {}),
  };
}

/** Whether a failed attempt is worth retrying. */
function isTransient(status: number | null): boolean {
  return status === null || status === 429 || status >= 500;
}

/**
 * Writes the catalogue to the sidecar (`PUT /v1/data/catalogue`). Never throws.
 *
 * @param doc - The document to publish.
 * @param options - Sidecar settings; default from config.
 * @returns Ok when OPA stored it; Err `OPA_UNAVAILABLE` (network, timeout,
 *   5xx after retries) or `OPA_REJECTED` (any other non-2xx).
 */
export async function publishEdgeCatalogue(
  doc: EdgeCatalogue,
  options: EdgePublishOptions = optionsFromConfig(),
): Promise<Result<void, BaseError>> {
  let base = options.baseUrl;
  while (base.endsWith('/')) base = base.slice(0, -1);
  const url = base + CATALOGUE_PATH;
  const fetchImpl = options.fetchImpl ?? fetch;
  const start = Date.now();
  let lastStatus: number | null = null;
  let lastError = '';
  for (let attempt = 0; attempt <= options.retries; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, options.backoffMs * 2 ** (attempt - 1)));
    }
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(doc),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (e) {
      lastStatus = null;
      lastError = String(e);
      continue;
    }
    if (res.ok) {
      logger.debug({
        operation: 'rbac.edge.publish',
        status: 'success',
        mode: doc.mode,
        catalogue_revision: doc.revision,
        roles: Object.keys(doc.roles).length,
        latency_ms: Date.now() - start,
      });
      return ok(undefined);
    }
    lastStatus = res.status;
    lastError = `HTTP ${res.status}`;
    if (!isTransient(res.status)) {
      return failed(
        new UpstreamError('OPA rejected the edge catalogue', {
          code: 'OPA_REJECTED',
          details: { status: res.status, path: CATALOGUE_PATH },
        }),
        start,
      );
    }
  }
  return failed(
    new UpstreamError('OPA is unavailable', {
      code: 'OPA_UNAVAILABLE',
      details: {
        status: lastStatus,
        error: lastError,
        attempts: options.retries + 1,
        path: CATALOGUE_PATH,
      },
    }),
    start,
  );
}

/** Logs a failed publish and returns it. */
function failed(e: UpstreamError, start: number): Result<void, BaseError> {
  logger.warn({
    operation: 'rbac.edge.publish',
    status: 'failure',
    error: e.message,
    error_type: e.code,
    latency_ms: Date.now() - start,
  });
  return err(e);
}

/**
 * Publishes a snapshot with the edge's mode, which is the API's `RBAC_MODE`.
 * Never throws: a failure is logged and retried on the next refresh tick,
 * and until then the edge refuses capability routes (fail closed).
 *
 * @param roles - The role snapshot.
 * @param revision - Its catalogue revision.
 * @param mode - The mode; `off` publishes nothing.
 * @returns What happened: `off`, `published` or `failed`.
 */
export async function publishSnapshotToEdge(
  roles: RoleIndex,
  revision: string,
  mode: EdgeMode,
): Promise<'off' | 'published' | 'failed'> {
  if (mode === 'off') return 'off';
  const res = await publishEdgeCatalogue(edgeCatalogue(roles, revision, mode));
  return res.success ? 'published' : 'failed';
}
