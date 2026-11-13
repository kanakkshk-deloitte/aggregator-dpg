/**
 * Fixed-window rate limiter backed by Redis, in `@aggregator-dpg/api`.
 *
 * Shared by the API's rate-limited routes. Windows and limits come from the caller.
 *
 * Key shape: `rl:{namespace}:{key}:{windowStart}` → INCR with EXPIRE.
 */

import type { Redis } from 'ioredis';
import { createRedisConnection } from '@aggregator-dpg/queue';
import { config } from '../../config.js';
import { logger } from '../../logger.js';

let instance: Redis | null = null;

function getRedis(): Redis {
  if (instance) return instance;
  // Dedicated fail-fast connection, not the BullMQ one: a downed Redis must
  // error within about 1s instead of hanging the request.
  instance = createRedisConnection({
    url: config.REDIS_URL,
    maxRetriesPerRequest: 1,
    commandTimeout: 1000,
    enableOfflineQueue: false,
  });
  // ioredis emits 'error' on every reconnect; consume() handles request-path failures.
  instance.on('error', () => undefined);
  return instance;
}

export interface RateLimitOptions {
  /** Logical bucket name (e.g. `link-submit`). */
  namespace: string;
  /** Identifier inside the bucket, e.g. slug, ip, or `${slug}:${ip}`. */
  key: string;
  /** Window length in seconds. */
  windowSeconds: number;
  /** Maximum events allowed per window. */
  max: number;
  /** Slots this call consumes; default 1. A bulk operation passes its item count. */
  cost?: number;
  /**
   * On a Redis error, deny instead of allow. Use for anti-abuse limits that
   * must hold when Redis is down, such as invite minting.
   */
  failClosed?: boolean;
}

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  retryAfterSeconds: number;
}

/** How long a command waits for the connection to come up before giving up. */
const READY_TIMEOUT_MS = 1000;

/**
 * Waits briefly for the connection to be usable.
 *
 * With the offline queue disabled, a command sent before the socket is ready
 * fails. Waiting avoids a false deny on the first call after boot. Bounded by
 * {@link READY_TIMEOUT_MS}, so an unreachable Redis still fails fast.
 *
 * @param redis - The limiter's connection.
 */
async function awaitReady(redis: Redis): Promise<void> {
  if (redis.status === 'ready') return;
  await new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      redis.off('ready', done);
      resolve();
    };
    const timer = setTimeout(done, READY_TIMEOUT_MS);
    redis.once('ready', done);
  });
}

/**
 * Consumes slots from a rate-limit bucket.
 *
 * @param options - Bucket, key, window, limit and failure behaviour.
 * @returns Whether the call is allowed, the window count and the retry delay.
 */
export async function consume(options: RateLimitOptions): Promise<RateLimitResult> {
  const redis = getRedis();
  const now = Date.now();
  const windowStart = Math.floor(now / 1000 / options.windowSeconds) * options.windowSeconds;
  const fullKey = `rl:${options.namespace}:${options.key}:${windowStart}`;
  try {
    await awaitReady(redis);
    // INCR and EXPIRE run in one MULTI, so a key never exists without a TTL.
    const cost = Math.max(1, Math.floor(options.cost ?? 1));
    const pipelineRes = await redis
      .multi()
      .incrby(fullKey, cost)
      .expire(fullKey, options.windowSeconds + 1)
      .exec();
    const incrEntry = pipelineRes?.[0];
    const count = Array.isArray(incrEntry) && typeof incrEntry[1] === 'number' ? incrEntry[1] : 0;
    if (count > options.max) {
      // Refund a denied call's slots so smaller later requests still fit. Best effort.
      await redis.decrby(fullKey, cost).catch(() => undefined);
      const retryAfterSeconds = Math.max(
        1,
        windowStart + options.windowSeconds - Math.floor(now / 1000),
      );
      return { allowed: false, count, retryAfterSeconds };
    }
    return { allowed: true, count, retryAfterSeconds: 0 };
  } catch (err) {
    logger.warn({
      operation: 'rateLimiter.consume',
      status: 'failure',
      error: (err as Error).message,
      namespace: options.namespace,
      fail_closed: options.failClosed ?? false,
    });
    // Fail open by default; failClosed callers deny instead.
    if (options.failClosed) {
      return { allowed: false, count: 0, retryAfterSeconds: options.windowSeconds };
    }
    return { allowed: true, count: 0, retryAfterSeconds: 0 };
  }
}

export async function closeRateLimiter(): Promise<void> {
  await instance?.quit().catch(() => undefined);
  instance = null;
}
