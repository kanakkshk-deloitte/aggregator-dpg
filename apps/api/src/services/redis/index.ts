/**
 * Shared ioredis singleton for the API process.
 *
 * Used by routes that need to read transient run-state owned by the worker
 * (e.g. live bulk-upload counters in `bu:<id>:counters`). Other services
 * such as the rate limiter and bull queues maintain their own connections.
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

/** Test helper — replace the singleton. */
export function _setRedis(r: Redis | null): void {
  instance = r;
}

/**
 * Closes the shared Redis connection. Idempotent; call from process shutdown.
 * Previously this singleton was leaked on SIGTERM (nothing closed it).
 */
export async function closeRedis(): Promise<void> {
  await instance?.quit().catch(() => undefined);
  instance = null;
}
