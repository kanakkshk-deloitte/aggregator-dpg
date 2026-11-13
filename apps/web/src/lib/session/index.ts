/**
 * Session store factory.
 *
 * Uses `RedisSessionStore` when `REDIS_URL` is set, otherwise
 * `MemorySessionStore`. Returns a process-wide singleton.
 */

import { MemorySessionStore } from './memory';
import { RedisSessionStore } from './redis';
import { type SessionStoreBase } from './interface';

let instance: SessionStoreBase | null = null;

/**
 * Returns the shared session store instance.
 *
 * @returns Active `SessionStoreBase` implementation.
 */
export function getSessionStore(): SessionStoreBase {
  if (instance) return instance;
  const ttlSec = Number(process.env.SESSION_TTL_SECONDS ?? 60 * 60 * 12);
  instance = process.env.REDIS_URL
    ? new RedisSessionStore({ ttlSec })
    : new MemorySessionStore({ ttlSec });
  return instance;
}

/**
 * Test-only helper to reset the singleton between suites.
 */
export function _resetSessionStore(): void {
  instance = null;
}

export { SessionStoreBase } from './interface';
export type { CachedActor, SessionData, SessionResult, SessionError } from './interface';
