/**
 * Redis-backed session store.
 *
 * Stores each session under `session:<sid>` with a sliding TTL that each
 * `get` refreshes.
 */

import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { SessionStoreBase, type SessionData, type SessionResult } from './interface';
import { getRedisClient } from './redis-client';

const KEY_PREFIX = 'session:';

export interface RedisSessionStoreOptions {
  /** Sliding TTL in seconds (default 12h). */
  ttlSec?: number;
  /** Inject a Redis client (for tests); defaults to shared singleton. */
  client?: Redis;
}

/**
 * Persists session state in Redis keyed by an opaque session ID.
 */
export class RedisSessionStore extends SessionStoreBase {
  private readonly redis: Redis;
  private readonly ttlSec: number;

  constructor(opts: RedisSessionStoreOptions = {}) {
    super();
    this.redis = opts.client ?? getRedisClient();
    this.ttlSec = opts.ttlSec ?? 60 * 60 * 12;
  }

  /**
   * Persists a new session and returns its opaque ID.
   *
   * @param data - Full session payload (tokens + claims).
   * @returns Newly generated session ID (UUID v4).
   */
  async create(data: SessionData): Promise<string> {
    const sid = randomUUID();
    await this.redis.set(KEY_PREFIX + sid, JSON.stringify(data), 'EX', this.ttlSec);
    return sid;
  }

  /**
   * Loads a session and slides its TTL forward.
   *
   * @param sid - Session ID from cookie.
   * @returns Session data or a structured error.
   */
  async get(sid: string): Promise<SessionResult<SessionData>> {
    if (!sid) {
      return { ok: false, error: { code: 'NOT_FOUND', message: 'empty sid' } };
    }
    let raw: string | null;
    try {
      raw = await this.redis.get(KEY_PREFIX + sid);
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'STORE_UNAVAILABLE',
          message: err instanceof Error ? err.message : 'redis error',
        },
      };
    }
    if (!raw) {
      return {
        ok: false,
        error: { code: 'NOT_FOUND', message: `session ${sid} not found` },
      };
    }
    let parsed: SessionData;
    try {
      parsed = JSON.parse(raw) as SessionData;
    } catch {
      return {
        ok: false,
        error: { code: 'CORRUPT', message: `session ${sid} unparseable` },
      };
    }
    // Slide the TTL; failure is non-fatal.
    void this.redis.expire(KEY_PREFIX + sid, this.ttlSec);
    return { ok: true, value: parsed };
  }

  /**
   * Merges a partial update into an existing session.
   *
   * @param sid - Session ID.
   * @param patch - Fields to overwrite.
   */
  async update(sid: string, patch: Partial<SessionData>): Promise<SessionResult<void>> {
    const existing = await this.get(sid);
    if (!existing.ok) return existing;
    const next: SessionData = {
      ...existing.value,
      ...patch,
      lastSeenAt: Date.now(),
    };
    await this.redis.set(KEY_PREFIX + sid, JSON.stringify(next), 'EX', this.ttlSec);
    return { ok: true, value: undefined };
  }

  /**
   * Removes a session. Idempotent — no error if the key is absent.
   *
   * @param sid - Session ID to delete.
   */
  async destroy(sid: string): Promise<void> {
    if (!sid) return;
    await this.redis.del(KEY_PREFIX + sid);
  }

  /**
   * No-op; the client is shared. Call `closeRedisClient()` on shutdown.
   */
  async close(): Promise<void> {
    /* shared client lifecycle is managed externally */
  }
}
