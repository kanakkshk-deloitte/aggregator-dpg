/**
 * Keeps the access token's `roles` claim in step with the database
 * (`@aggregator-dpg/api`, RBAC edge enforcement).
 *
 * The edge reads the caller's live role keys from a `roles` claim
 * (docs/rbac/rbac-edge-enforcement.md §3.2). Keycloak copies it from an
 * admin-only `roles` user attribute, which this module writes. Postgres is the
 * source of truth and the attribute a projection: every write recomputes the
 * user's whole list and overwrites it, so a missed or failed write is repaired
 * by the next one (a later change, the sweep, or the reconcile).
 *
 * Runs only with `RBAC_MODE` other than `off`. Never throws and never
 * fails the request that triggered it: a failure is logged and the user is
 * marked for the next sweep.
 */

import { randomUUID } from 'node:crypto';
import { effectiveRoleKeys } from '@aggregator-dpg/rbac';
import { logger } from '../../logger.js';
import { StoreActorResolver, type Actor, type ActorResult } from '../auth/actor/index.js';
import { KC_ATTR } from '../idp-admin/attributes.js';
import { getIdpAdmin } from '../idp-admin/index.js';
import { IDP_PROVIDER } from '../idp-admin/provider.js';
import { getIdentityStore } from '../identity-store/index.js';
import { getRedis } from '../redis/index.js';
import { TEST_TOKEN_ROLES_OFF_KEY } from './edge-test-hook.js';
import { getRbacRuntime } from './runtime.js';

/** Keycloak user attribute (and token claim) holding the role keys. */
export const ROLES_ATTRIBUTE = 'roles';

/** Redis set of users whose last write failed or was deferred. */
export const DIRTY_KEY = 'rbac:token-roles:dirty';

/** What one sync did. */
export type TokenRolesOutcome =
  | 'off' // the edge is off, or RBAC is off
  | 'synced' // the attribute now holds the user's roles
  | 'no_login' // the account has no Keycloak user to write to
  | 'deferred' // another write for this user held the lock; marked for the sweep
  | 'failed'; // a store or Keycloak call failed; marked for the sweep

/** A failure from one of the dependencies, kept generic for logging. */
interface DepFailure {
  ok: false;
  error: { code: string; message: string };
}

/** What the sync needs from the rest of the app; injectable for tests. */
export interface TokenRolesDeps {
  /** The account's actor, as the API resolves it (memberships and live roles). */
  actorOf(userId: string): Promise<ActorResult>;
  /** The account's Keycloak user id; null when it has none (no login yet). */
  idpUserOf(userId: string, actor: Actor): Promise<{ ok: true; value: string | null } | DepFailure>;
  /** Overwrites the Keycloak `roles` attribute; null removes it. */
  writeRoles(idpUserId: string, roles: string[] | null): Promise<{ ok: true } | DepFailure>;
  /** Runs `fn` holding the user's lock; `acquired: false` when another writer kept it. */
  withLock<T>(
    userId: string,
    fn: () => Promise<T>,
  ): Promise<{ acquired: true; value: T } | { acquired: false }>;
  /** Marks a user for the next sweep. Best effort. */
  markDirty(userId: string): Promise<void>;
  /** Epoch milliseconds. */
  now(): number;
}

/** How long a lock is held at most, and how long a writer waits for one. */
const LOCK_TTL_MS = 15_000;
const LOCK_WAIT_MS = 3_000;
const LOCK_POLL_MS = 50;

/** Retries of a failed Keycloak write, and the base backoff between them. */
const WRITE_RETRIES = 1;
const WRITE_BACKOFF_MS = 200;

/** Deletes the lock only if it is still ours. */
const RELEASE_SCRIPT = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/**
 * The role keys an actor's token should carry: none for an inactive account,
 * otherwise the roles that give it a permission in any of its organisations.
 *
 * @param actor - The resolved actor, or null when there is no such account.
 * @param now - Epoch milliseconds, for expiry.
 * @returns Sorted role keys; empty with RBAC off (no catalogue).
 */
export function tokenRolesOf(actor: Actor | null, now: number): string[] {
  const rt = getRbacRuntime();
  if (!rt || !actor?.active) return [];
  return effectiveRoleKeys(
    rt.roles,
    {
      userType: actor.userType,
      memberships: actor.orgs.map((o) => ({
        orgId: o.id,
        orgType: o.orgType,
        relation: o.relation,
      })),
      held: actor.roles ?? [],
    },
    now,
  );
}

/** The app's real dependencies. */
export function defaultTokenRolesDeps(): TokenRolesDeps {
  const resolver = new StoreActorResolver();
  return {
    actorOf: (userId) => resolver.byUserId(userId),
    async idpUserOf(userId, actor) {
      const linked = await getIdentityStore().subjectOf(userId, IDP_PROVIDER);
      if (!linked.ok) return { ok: false, error: linked.error };
      if (linked.value) return { ok: true, value: linked.value };
      // Coordinator logins are recorded lazily; find the user by its pointer.
      if (actor.userType !== 'coordinator') return { ok: true, value: null };
      const found = await getIdpAdmin().findByAttribute(KC_ATTR.AGGREGATOR_ID, userId);
      if (!found.ok) return { ok: false, error: found.error };
      return { ok: true, value: found.value?.id ?? null };
    },
    async writeRoles(idpUserId, roles) {
      // Keycloak admin calls carry a timeout but no retry; an overwrite of the
      // whole list is idempotent, so one retry with backoff is safe.
      for (let attempt = 0; ; attempt++) {
        const res = await getIdpAdmin().setAttributes(idpUserId, { [ROLES_ATTRIBUTE]: roles });
        if (res.ok) return { ok: true };
        if (attempt >= WRITE_RETRIES || res.error.code === 'USER_NOT_FOUND') {
          return { ok: false, error: res.error };
        }
        await new Promise((r) => setTimeout(r, WRITE_BACKOFF_MS * 2 ** attempt));
      }
    },
    withLock: redisLock,
    async markDirty(userId) {
      try {
        await getRedis().sadd(DIRTY_KEY, userId);
      } catch (e) {
        logger.warn({
          operation: 'rbac.token_roles.mark_dirty',
          status: 'failure',
          user_id: userId,
          error: e instanceof Error ? e.message : String(e),
          error_type: e instanceof Error ? e.constructor.name : 'unknown',
        });
      }
    },
    now: () => Date.now(),
  };
}

/**
 * Runs `fn` holding a per-user Redis lock, so two writes for one user cannot
 * overwrite each other (`setAttributes` reads and rewrites the whole Keycloak
 * user). When Redis itself is down the write proceeds unlocked: a lost update
 * is repaired by the next write or the reconcile, while skipping would leave
 * the claim stale.
 */
async function redisLock<T>(
  userId: string,
  fn: () => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const key = `rbac:token-roles:lock:${userId}`;
  const token = `${process.pid}-${randomUUID()}`;
  const redis = getRedis();
  const deadline = Date.now() + LOCK_WAIT_MS;
  let held = false;
  try {
    for (;;) {
      held = (await redis.set(key, token, 'PX', LOCK_TTL_MS, 'NX')) === 'OK';
      if (held || Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
    }
  } catch (e) {
    logger.warn({
      operation: 'rbac.token_roles.lock',
      status: 'failure',
      user_id: userId,
      error: e instanceof Error ? e.message : String(e),
      error_type: e instanceof Error ? e.constructor.name : 'unknown',
    });
    return { acquired: true, value: await fn() };
  }
  if (!held) return { acquired: false };
  try {
    return { acquired: true, value: await fn() };
  } finally {
    await redis.eval(RELEASE_SCRIPT, 1, key, token).catch(() => undefined);
  }
}

/**
 * Recomputes one user's role keys from the database and writes them to their
 * Keycloak `roles` attribute. Never throws.
 *
 * @param userId - The account (`users.id`).
 * @param reason - Why, for the log (`role_assigned`, `sweep`, …).
 * @param deps - Dependencies; the app's own by default.
 * @returns What happened.
 */
export async function syncTokenRoles(
  userId: string,
  reason: string,
  deps?: TokenRolesDeps,
): Promise<TokenRolesOutcome> {
  if (!getRbacRuntime()) return 'off';
  // Unit tests: the default dependencies would reach Redis and Keycloak.
  if (!deps && (globalThis as Record<string, unknown>)[TEST_TOKEN_ROLES_OFF_KEY]) return 'off';
  return run(userId, reason, deps ?? defaultTokenRolesDeps());
}

/** One sync with resolved dependencies. */
async function run(
  userId: string,
  reason: string,
  deps: TokenRolesDeps,
): Promise<TokenRolesOutcome> {
  const start = Date.now();
  const log = (status: 'success' | 'failure' | 'skipped', extra: Record<string, unknown>) =>
    (status === 'failure' ? logger.warn : logger.info).call(logger, {
      operation: 'rbac.token_roles.sync',
      status,
      user_id: userId,
      reason,
      latency_ms: Date.now() - start,
      ...extra,
    });
  const fail = async (step: string, error: { code: string; message: string }) => {
    log('failure', { sub_operation: step, error: error.message, error_type: error.code });
    await deps.markDirty(userId);
    return 'failed' as const;
  };

  try {
    const locked = await deps.withLock(userId, async (): Promise<TokenRolesOutcome> => {
      const actor = await deps.actorOf(userId);
      if (!actor.ok) return fail('actorOf', actor.error);
      if (!actor.value) {
        log('skipped', { reasons: ['no_account'] });
        return 'no_login';
      }
      const roles = tokenRolesOf(actor.value, deps.now());
      const idp = await deps.idpUserOf(userId, actor.value);
      if (!idp.ok) return fail('idpUserOf', idp.error);
      if (!idp.value) {
        log('skipped', { reasons: ['no_login'], roles: roles.length });
        return 'no_login';
      }
      const written = await deps.writeRoles(idp.value, roles.length > 0 ? roles : null);
      if (!written.ok) return fail('writeRoles', written.error);
      log('success', { roles: roles.length });
      return 'synced';
    });
    if (locked.acquired) return locked.value;
    log('skipped', { reasons: ['locked'] });
    await deps.markDirty(userId);
    return 'deferred';
  } catch (e) {
    return fail('unexpected', {
      code: e instanceof Error ? e.constructor.name : 'unknown',
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Starts a sync for each user after a role change, without waiting: the
 * change has committed and its response must not wait on Keycloak. No-op when
 * the edge is off. Null and duplicate ids are skipped.
 *
 * @param userIds - The accounts whose roles may have changed.
 * @param reason - Why, for the log.
 */
export function requestTokenRolesSync(
  userIds: ReadonlyArray<string | null | undefined>,
  reason: string,
): void {
  if (!getRbacRuntime()) return;
  const ids = [...new Set(userIds.filter((id): id is string => !!id))];
  for (const id of ids) void syncTokenRoles(id, reason);
}
