/**
 * Which Keycloak realm roles mark a Signals participant.
 *
 * The portal and the Signals app share one realm, so a token without
 * `aggregator_id` may be a valid Signals account. The login screen uses this
 * list to say so.
 *
 * The list is read server-side from `aggregator.signals.realm_roles` in the
 * network's `aggregator.config.yaml`. `SIGNALS_REALM_ROLES` overrides it.
 * It must match Signals' `KEYCLOAK_REQUIRED_REALM_ROLES`. When empty, the
 * login screen shows generic text.
 *
 * @module apps/web/src/lib/signals-roles
 */

import 'server-only';
import { loadSignalsRealmRoles } from '@aggregator-dpg/config-loader/fs';
import { logger } from './logger';

/** Env var with comma-separated Signals participant roles (override). */
const ENV_KEY = 'SIGNALS_REALM_ROLES';

/**
 * Returns the Signals participant realm roles set by the env override.
 *
 * @param env - Env bag; defaults to `process.env`.
 * @returns Role names, or an empty array when unset.
 */
function envRealmRoles(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env[ENV_KEY] ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
}

/**
 * Memoised result, read once per process. `undefined` means not resolved yet.
 */
let cached: string[] | undefined;

/**
 * Resolves the Signals participant realm roles: env override first, then the
 * active network's config file.
 *
 * Never throws. A config read error is logged and gives an empty list.
 *
 * @returns The role names, or an empty array when unconfigured.
 */
export async function resolveSignalsRealmRoles(): Promise<string[]> {
  if (cached !== undefined) return cached;

  const fromEnv = envRealmRoles();
  if (fromEnv.length > 0) {
    cached = fromEnv;
    return cached;
  }

  const network = process.env.AGGREGATOR_NETWORK?.trim() || 'blue_dot';
  const brand = process.env.AGGREGATOR_BRAND?.trim() || undefined;
  const start = Date.now();
  try {
    cached = await loadSignalsRealmRoles(network, brand, process.env.CONFIG_ROOT?.trim());
  } catch (err) {
    logger.warn({
      operation: 'signalsRealmRoles.loadFromConfig',
      status: 'failure',
      error: err instanceof Error ? err.message : String(err),
      error_type: err instanceof Error ? err.constructor.name : 'unknown',
      latency_ms: Date.now() - start,
      network,
      brand,
    });
    cached = [];
  }
  return cached;
}

/**
 * Clears the memoised roles. Test-only.
 */
export function resetSignalsRealmRolesCache(): void {
  cached = undefined;
}
