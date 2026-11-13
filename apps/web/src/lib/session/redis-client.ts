/**
 * Shared ioredis client for the process.
 *
 * ioredis multiplexes commands on one connection, so do not create a client
 * per request. The client is created on first use and reconnects on its own;
 * call `closeRedisClient()` on shutdown.
 */

import Redis, { type RedisOptions } from 'ioredis';

let client: Redis | null = null;
let closing = false;

const DEFAULT_OPTIONS: RedisOptions = {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: false,
  connectTimeout: 5000,
  keepAlive: 30000,
  // Retry on each disconnect with exponential backoff capped at 2s.
  retryStrategy(times: number): number {
    return Math.min(50 * 2 ** times, 2000);
  },
};

/**
 * Returns the shared Redis client, creating it on first use.
 *
 * @param url - Optional Redis URL. Falls back to `REDIS_URL` env var,
 *   then `redis://localhost:6379`.
 * @returns Shared ioredis instance.
 * @throws {Error} If the client is shutting down.
 */
export function getRedisClient(url?: string): Redis {
  if (client && !closing) return client;
  if (closing) throw new Error('Redis client is shutting down');

  const target = url ?? process.env.REDIS_URL ?? 'redis://localhost:6379';
  client = new Redis(target, DEFAULT_OPTIONS);
  return client;
}

/**
 * Closes the shared Redis client. Idempotent.
 *
 * Call from shutdown handlers. A later `getRedisClient()` opens a new client.
 */
export async function closeRedisClient(): Promise<void> {
  if (!client) return;
  closing = true;
  try {
    await client.quit();
  } finally {
    client = null;
    closing = false;
  }
}

/**
 * Test-only helper to inject a custom client. Resets the singleton.
 */
export function _setRedisClient(c: Redis | null): void {
  client = c;
}
