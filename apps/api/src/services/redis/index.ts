/**
 * Shared ioredis connection for the API process (`@aggregator-dpg/api`).
 *
 * Used by routes that read run-state written by the worker, such as
 * bulk-upload counters in `bu:<id>:counters`. The rate limiter and queues use
 * their own connections.
 */

import type { Redis } from 'ioredis';
import { createRedisConnection } from '@aggregator-dpg/queue';
import { config } from '../../config.js';

let instance: Redis | null = null;

export function getRedis(): Redis {
  if (instance) return instance;
  instance = createRedisConnection({ url: config.REDIS_URL });
  return instance;
}

/** Test helper; replaces the singleton. */
export function _setRedis(r: Redis | null): void {
  instance = r;
}

/**
 * Closes the shared Redis connection. Idempotent; call from process shutdown.
 */
export async function closeRedis(): Promise<void> {
  await instance?.quit().catch(() => undefined);
  instance = null;
}
