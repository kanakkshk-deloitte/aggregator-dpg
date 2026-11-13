/**
 * Shared ioredis connection for the worker app, used by BullMQ and Lua scripts.
 */

import { createRedisConnection } from '@aggregator-dpg/queue';
import type { Redis } from 'ioredis';
import { config } from '../config.js';

let instance: Redis | null = null;

export function getRedis(): Redis {
  if (instance) return instance;
  instance = createRedisConnection({ url: config.REDIS_URL });
  return instance;
}

export async function closeRedis(): Promise<void> {
  await instance?.quit().catch(() => undefined);
  instance = null;
}
