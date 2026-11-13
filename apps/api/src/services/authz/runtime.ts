/**
 * RBAC runtime state for `@aggregator-dpg/api`: the mode, the role snapshot
 * and the decision engine.
 *
 * Built-in roles and permissions are seeded by migration `0031_rbac_seed.sql`.
 * With RBAC on, the API loads every role into a snapshot. A timer re-reads the
 * catalogue revision and reloads when it changed, so custom-role writes on
 * other instances reach this one. An invalid catalogue stops the boot; on a
 * later refresh the last good snapshot is kept, so a bad edit cannot change access.
 *
 * With `RBAC_MODE=off` nothing is loaded, no access check runs, and no OPA
 * sidecar is needed.
 */

import {
  OpaAuthorizer,
  assertRoleCatalogue,
  indexRoles,
  type AuthorizerBase,
  type RoleIndex,
} from '@aggregator-dpg/rbac';
import { ConfigError } from '@aggregator-dpg/shared-primitives/errors';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { getRbacCatalogue, type RbacCatalogueBase } from '../rbac-catalogue/index.js';
import { publishSnapshotToEdge } from './edge-catalogue.js';

/** `off`, `log` (decide and log, never block) or `enforce`. */
export type RbacMode = 'off' | 'log' | 'enforce';

/** Loaded RBAC state. */
export interface RbacRuntime {
  mode: Exclude<RbacMode, 'off'>;
  /** Every role (built-in and custom), indexed. */
  roles: RoleIndex;
  authorizer: AuthorizerBase;
  /** The catalogue revision the snapshot was read at; absent when set by a test. */
  catalogueRevision?: string;
}

/**
 * Re-publishes the current snapshot to the edge, in the runtime's mode, so a
 * restarted OPA sidecar gets the catalogue back within one tick.
 *
 * @returns What happened; `off` when RBAC is off.
 */
export async function publishCurrentToEdge(): Promise<'off' | 'published' | 'failed'> {
  const current = runtime;
  if (!current?.catalogueRevision) return 'off';
  return publishSnapshotToEdge(current.roles, current.catalogueRevision, current.mode);
}

/** What a refresh did. */
export type RefreshOutcome = 'off' | 'unchanged' | 'reloaded' | 'failed';

let runtime: RbacRuntime | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let refreshing: Promise<RefreshOutcome> | null = null;

/** A store failure at boot is a configuration problem: the API cannot decide. */
function unavailable(op: string, message: string): ConfigError {
  return new ConfigError(`RBAC catalogue unavailable (${op})`, {
    code: 'RBAC_CATALOGUE_UNAVAILABLE',
    details: { operation: op, message },
  });
}

/**
 * Loads every role and checks the role rules.
 *
 * When `RBAC_CUSTOM_ROLES_ENABLED` is false, custom roles are dropped here, so
 * existing custom-role assignments grant nothing.
 *
 * @param store - The catalogue store.
 * @returns The indexed roles and their revision.
 * @throws {ConfigError} `RBAC_CATALOGUE_UNAVAILABLE` or `RBAC_CONFIG_INVALID`.
 */
async function loadSnapshot(
  store: RbacCatalogueBase,
): Promise<{ roles: RoleIndex; revision: string }> {
  const loaded = await store.load();
  if (!loaded.ok) throw unavailable('load', loaded.error.message);
  const roles = config.RBAC_CUSTOM_ROLES_ENABLED
    ? loaded.value.roles
    : loaded.value.roles.filter((r) => r.isBuiltin);
  assertRoleCatalogue(roles, `database catalogue (revision ${loaded.value.revision})`);
  return { roles: indexRoles(roles), revision: loaded.value.revision };
}

/**
 * Loads the role snapshot and builds the OPA engine, unless `RBAC_MODE` is
 * `off`; then starts the refresh timer. Called once at boot.
 *
 * @param mode - Defaults to `RBAC_MODE`.
 * @param refreshMs - Refresh interval; defaults to `RBAC_CATALOGUE_REFRESH_MS`,
 *   `0` disables the timer.
 * @throws {ConfigError} When the catalogue cannot be read or is invalid.
 */
export async function initRbac(
  mode: RbacMode = config.RBAC_MODE,
  refreshMs: number = config.RBAC_CATALOGUE_REFRESH_MS,
): Promise<void> {
  stopRbacRefresh();
  if (mode === 'off') {
    runtime = null;
    // Custom roles do nothing while RBAC is off; tell the operator.
    if (config.RBAC_CUSTOM_ROLES_ENABLED) {
      logger.warn({
        operation: 'rbac.init',
        status: 'skipped',
        mode,
        error: 'RBAC_CUSTOM_ROLES_ENABLED has no effect while RBAC_MODE=off',
      });
    }
    logger.info({ operation: 'rbac.init', status: 'skipped', mode });
    return;
  }
  const store = getRbacCatalogue();
  const snapshot = await loadSnapshot(store);
  runtime = {
    mode,
    roles: snapshot.roles,
    catalogueRevision: snapshot.revision,
    authorizer: new OpaAuthorizer({
      baseUrl: config.OPA_URL,
      timeoutMs: config.OPA_TIMEOUT_MS,
      retries: config.OPA_RETRIES,
      backoffMs: config.OPA_BACKOFF_MS,
    }),
  };
  // A failed publish only delays the edge: it is retried on every tick.
  await publishSnapshotToEdge(snapshot.roles, snapshot.revision, mode);
  if (refreshMs > 0) {
    timer = setInterval(
      () => void refreshRbacCatalogue().then(() => publishCurrentToEdge()),
      refreshMs,
    );
    timer.unref();
  }
  logger.info({
    operation: 'rbac.init',
    status: 'success',
    mode,
    roles: snapshot.roles.byKey.size,
    catalogue_revision: snapshot.revision,
    refresh_ms: refreshMs,
  });
}

/** One refresh: reload only when the revision changed; keep the last good snapshot. */
async function refreshOnce(): Promise<RefreshOutcome> {
  const current = runtime;
  if (!current) return 'off';
  const store = getRbacCatalogue();
  const revision = await store.revision();
  if (!revision.ok) {
    logger.warn({
      operation: 'rbac.catalogue.refresh',
      status: 'failure',
      error: revision.error.code,
    });
    return 'failed';
  }
  if (revision.value === current.catalogueRevision) return 'unchanged';
  try {
    const snapshot = await loadSnapshot(store);
    if (runtime === current) {
      runtime = { ...current, roles: snapshot.roles, catalogueRevision: snapshot.revision };
    }
    logger.info({
      operation: 'rbac.catalogue.refresh',
      status: 'success',
      from_revision: current.catalogueRevision,
      to_revision: snapshot.revision,
    });
    await publishSnapshotToEdge(snapshot.roles, snapshot.revision, current.mode);
    return 'reloaded';
  } catch (err) {
    logger.error({
      operation: 'rbac.catalogue.refresh',
      status: 'failure',
      error: err instanceof Error ? err.message : String(err),
      error_type: err instanceof ConfigError ? err.code : 'unknown',
      kept_revision: current.catalogueRevision,
    });
    return 'failed';
  }
}

/**
 * Reloads the snapshot when the catalogue revision changed. Runs on the timer
 * and right after a role write on this replica.
 *
 * A caller that arrives while a refresh is running is queued behind it, so
 * every caller sees a revision read taken after it asked.
 *
 * @returns What the refresh did for this caller.
 */
export function refreshRbacCatalogue(): Promise<RefreshOutcome> {
  const run = (): Promise<RefreshOutcome> => refreshOnce();
  const next: Promise<RefreshOutcome> = refreshing ? refreshing.then(run, run) : run();
  refreshing = next;
  void next.finally(() => {
    // Only the last queued run clears the chain.
    if (refreshing === next) refreshing = null;
  });
  return next;
}

/** Stops the refresh timer (shutdown, re-init, tests). */
export function stopRbacRefresh(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/**
 * Returns the loaded state, or null when RBAC is off.
 *
 * @returns The runtime, or null.
 */
export function getRbacRuntime(): RbacRuntime | null {
  return runtime;
}

/** Test helper — replace the runtime. */
export function _setRbacRuntime(r: RbacRuntime | null): void {
  runtime = r;
}
