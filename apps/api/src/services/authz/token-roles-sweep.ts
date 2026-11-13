/**
 * Background repair of the token `roles` claim (`@aggregator-dpg/api`, RBAC
 * edge enforcement, docs/rbac/rbac-edge-enforcement.md §3.2).
 *
 * Role changes refresh the claim as they happen (`token-roles.ts`). Two cases
 * have no event, so a timer in the API covers them:
 *
 * - **Sweep** (every `RBAC_TOKEN_ROLES_SWEEP_MS`): users marked after a failed
 *   or deferred write, and users whose timed role (PII Access) expired since
 *   the last sweep.
 * - **Reconcile** (at boot, then every `RBAC_TOKEN_ROLES_RECONCILE_MS`): every
 *   user, to repair any drift; it also covers the root and Default owner
 *   changes the boot-time owner reconcile makes.
 *
 * Each run takes a Redis lock so one replica runs it. Writes are idempotent
 * (the whole list each time), so an overlap is harmless, only wasteful.
 */

import { config } from '../../config.js';
import { getDb } from '../../db/client.js';
import { users } from '../../db/schema.js';
import { logger } from '../../logger.js';
import { getRedis } from '../redis/index.js';
import { getRoleStore } from '../role-store/index.js';
import { getRbacRuntime } from './runtime.js';
import { DIRTY_KEY, syncTokenRoles, type TokenRolesOutcome } from './token-roles.js';

/** What a sweep or reconcile needs; injectable for tests. */
export interface SweepDeps {
  /** Every account id. */
  listUserIds(): Promise<string[]>;
  /** Users with an unrevoked assignment that expired in (`from`, `to`]. */
  listExpired(from: Date, to: Date): Promise<string[]>;
  /** Takes up to `count` users marked for a retry. */
  popDirty(count: number): Promise<string[]>;
  /** Runs `fn` when this replica wins the named lock; false when another holds it. */
  once(name: string, ttlMs: number, fn: () => Promise<void>): Promise<boolean>;
  /** Syncs one user. */
  sync(userId: string, reason: string): Promise<TokenRolesOutcome>;
  /** Epoch milliseconds. */
  now(): number;
}

/** How many users one sweep retries, and how many syncs run at once. */
const DIRTY_BATCH = 500;
const CONCURRENCY = 5;

/** The app's real dependencies. */
export function defaultSweepDeps(): SweepDeps {
  return {
    async listUserIds() {
      const rows = await getDb().select({ id: users.id }).from(users);
      return rows.map((r) => r.id);
    },
    async listExpired(from, to) {
      const res = await getRoleStore().listUsersExpiredBetween(from, to);
      if (!res.ok) throw new Error(`roleStore.listUsersExpiredBetween: ${res.error.message}`);
      return res.value;
    },
    async popDirty(count) {
      const popped = await getRedis().spop(DIRTY_KEY, count);
      return popped ?? [];
    },
    async once(name, ttlMs, fn) {
      const key = `rbac:token-roles:${name}`;
      const got = (await getRedis().set(key, String(process.pid), 'PX', ttlMs, 'NX')) === 'OK';
      if (!got) return false;
      await fn();
      return true;
    },
    sync: (userId, reason) => syncTokenRoles(userId, reason),
    now: () => Date.now(),
  };
}

/** Syncs `ids` a few at a time and counts the outcomes. */
async function syncAll(
  ids: readonly string[],
  reason: string,
  deps: SweepDeps,
): Promise<Record<TokenRolesOutcome, number>> {
  const counts: Record<TokenRolesOutcome, number> = {
    off: 0,
    synced: 0,
    no_login: 0,
    deferred: 0,
    failed: 0,
  };
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const batch = ids.slice(i, i + CONCURRENCY);
    for (const outcome of await Promise.all(batch.map((id) => deps.sync(id, reason)))) {
      counts[outcome] += 1;
    }
  }
  return counts;
}

/** Runs one job under its lock; logs the outcome; never throws. */
async function runJob(
  name: 'sweep' | 'reconcile',
  lockMs: number,
  deps: SweepDeps,
  work: () => Promise<Record<string, unknown>>,
): Promise<'ran' | 'skipped' | 'failed'> {
  const start = deps.now();
  try {
    let summary: Record<string, unknown> = {};
    const ran = await deps.once(name, lockMs, async () => {
      summary = await work();
    });
    if (!ran) return 'skipped';
    logger.info({
      operation: `rbac.token_roles.${name}`,
      status: 'success',
      latency_ms: deps.now() - start,
      ...summary,
    });
    return 'ran';
  } catch (e) {
    logger.warn({
      operation: `rbac.token_roles.${name}`,
      status: 'failure',
      error: e instanceof Error ? e.message : String(e),
      error_type: e instanceof Error ? e.constructor.name : 'unknown',
      latency_ms: deps.now() - start,
    });
    return 'failed';
  }
}

/**
 * Retries users marked after a failed write and re-syncs users whose timed
 * role expired in the look-back window (twice the sweep interval, so a late
 * or skipped tick still catches it). Never throws.
 *
 * @param sweepMs - The sweep interval.
 * @param deps - Dependencies; the app's own by default.
 * @returns `ran`, `skipped` (another replica holds the lock) or `failed`.
 */
export async function sweepTokenRoles(
  sweepMs: number = config.RBAC_TOKEN_ROLES_SWEEP_MS,
  deps: SweepDeps = defaultSweepDeps(),
): Promise<'ran' | 'skipped' | 'failed'> {
  return runJob('sweep', Math.max(sweepMs, 1_000), deps, async () => {
    const now = deps.now();
    const window = 2 * Math.max(sweepMs, 1_000);
    const [dirty, expired] = await Promise.all([
      deps.popDirty(DIRTY_BATCH),
      deps.listExpired(new Date(now - window), new Date(now)),
    ]);
    const retried = await syncAll([...new Set(dirty)], 'retry', deps);
    const ids = [...new Set(expired)].filter((id) => !dirty.includes(id));
    const expiredOutcomes = await syncAll(ids, 'expired', deps);
    return { retried: dirty.length, expired: ids.length, retry: retried, expiry: expiredOutcomes };
  });
}

/**
 * Re-syncs every user's claim. Never throws.
 *
 * @param deps - Dependencies; the app's own by default.
 * @returns `ran`, `skipped` (another replica holds the lock) or `failed`.
 */
export async function reconcileTokenRoles(
  deps: SweepDeps = defaultSweepDeps(),
): Promise<'ran' | 'skipped' | 'failed'> {
  return runJob('reconcile', 10 * 60_000, deps, async () => {
    const ids = await deps.listUserIds();
    const outcomes = await syncAll(ids, 'reconcile', deps);
    return { users: ids.length, ...outcomes };
  });
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;
let reconcileTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Starts the sweep and the reconcile when the edge is on: a reconcile right
 * away (in the background), then both on their intervals. Call after
 * `initRbac`. A no-op with `RBAC_MODE=off`; an interval of `0`
 * disables that job.
 */
export function startTokenRolesRepair(): void {
  stopTokenRolesRepair();
  if (!getRbacRuntime()) return;
  void reconcileTokenRoles();
  if (config.RBAC_TOKEN_ROLES_SWEEP_MS > 0) {
    sweepTimer = setInterval(() => void sweepTokenRoles(), config.RBAC_TOKEN_ROLES_SWEEP_MS);
    sweepTimer.unref();
  }
  if (config.RBAC_TOKEN_ROLES_RECONCILE_MS > 0) {
    reconcileTimer = setInterval(
      () => void reconcileTokenRoles(),
      config.RBAC_TOKEN_ROLES_RECONCILE_MS,
    );
    reconcileTimer.unref();
  }
}

/** Stops both timers; call on shutdown. Idempotent. */
export function stopTokenRolesRepair(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  if (reconcileTimer) clearInterval(reconcileTimer);
  sweepTimer = null;
  reconcileTimer = null;
}
