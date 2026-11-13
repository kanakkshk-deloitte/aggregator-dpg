/**
 * Server-side read of the aggregator's deploy-time capability flags.
 *
 * Flags come from `GET /v1/aggregator-config` (`features.custom_roles`). The
 * console layout, roles page and role-mutation BFF routes read them here.
 * Fails safe to `false`, so an api problem hides the admin screens.
 *
 * @module apps/web/src/lib/features.server
 */

import 'server-only';
import { cache } from 'react';
import { logger } from './logger';

/** Deploy-time capability flags surfaced by `GET /v1/aggregator-config`. */
export interface AggregatorFeatures {
  custom_roles: boolean;
}

const FETCH_TIMEOUT_MS = 5000;

/** Fail-safe default when the api is unreachable or omits the field. */
const DEFAULT_FEATURES: AggregatorFeatures = { custom_roles: false };

/**
 * Logs a warning without ever throwing.
 *
 * The logger's transport worker can exit under the dev server and make
 * `logger.warn` throw; the fail-safe return must still happen.
 *
 * @param payload - Structured log fields.
 */
function warnSafe(payload: Record<string, unknown>): void {
  try {
    logger.warn(payload);
  } catch {
    /* logging must never break the request */
  }
}

/**
 * Reads the deploy-time capability flags from the aggregator api.
 *
 * On any failure returns {@link DEFAULT_FEATURES} (everything off). Never
 * throws. Wrapped in React's `cache()`, so one request makes one upstream call.
 *
 * @returns The resolved feature flags, or the fail-safe default.
 */
export const getAggregatorFeatures = cache(
  async function getAggregatorFeatures(): Promise<AggregatorFeatures> {
    const base = process.env.API_BASE_URL ?? 'http://localhost:4000';
    const start = Date.now();
    try {
      const res = await fetch(`${base}/v1/aggregator-config`, {
        method: 'GET',
        cache: 'no-store',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        warnSafe({
          operation: 'features.getAggregatorFeatures',
          status: 'failure',
          error: `HTTP ${res.status}`,
          latency_ms: Date.now() - start,
        });
        return DEFAULT_FEATURES;
      }
      const cfg = (await res.json()) as { features?: { custom_roles?: unknown } };
      return { custom_roles: cfg.features?.custom_roles === true };
    } catch (err) {
      warnSafe({
        operation: 'features.getAggregatorFeatures',
        status: 'failure',
        error: err instanceof Error ? err.message : String(err),
        latency_ms: Date.now() - start,
      });
      return DEFAULT_FEATURES;
    }
  },
);

/**
 * Whether the custom-roles capability is enabled for this deployment.
 *
 * @returns True when the api reports `features.custom_roles === true`.
 */
export async function customRolesEnabled(): Promise<boolean> {
  return (await getAggregatorFeatures()).custom_roles;
}
