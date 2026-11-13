/**
 * Unit tests for the worker's shared ioredis singleton.
 *
 * `@aggregator-dpg/queue`'s `createRedisConnection` factory is mocked so no
 * real socket is opened — only the singleton lifecycle (lazy construction,
 * caching, teardown, teardown-failure swallowing) is under test.
 *
 * @module @aggregator-dpg/worker
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const createRedisConnection = vi.fn();
vi.mock('@aggregator-dpg/queue', () => ({ createRedisConnection }));

vi.mock('../config.js', () => ({ config: { REDIS_URL: 'redis://worker-test:6379' } }));

const { getRedis, closeRedis } = await import('./redis.js');

function makeFakeRedis(): { quit: ReturnType<typeof vi.fn> } {
  return { quit: vi.fn(async () => 'OK') };
}

describe('worker redis singleton', () => {
  beforeEach(() => {
    createRedisConnection.mockReset();
  });

  it('lazily creates a connection from config.REDIS_URL on first getRedis() call', () => {
    const fake = makeFakeRedis();
    createRedisConnection.mockReturnValueOnce(fake);

    const redis = getRedis();

    expect(redis).toBe(fake);
    expect(createRedisConnection).toHaveBeenCalledExactlyOnceWith({
      url: 'redis://worker-test:6379',
    });
  });

  it('caches the connection — a second call does not create a new one', () => {
    const before = getRedis();
    const after = getRedis();

    expect(after).toBe(before);
    expect(createRedisConnection).not.toHaveBeenCalled();
  });

  it('closeRedis() quits the connection and resets the singleton', async () => {
    const before = getRedis();
    const beforeFake = before as unknown as { quit: ReturnType<typeof vi.fn> };

    await closeRedis();

    expect(beforeFake.quit).toHaveBeenCalledOnce();

    const fresh = makeFakeRedis();
    createRedisConnection.mockReturnValueOnce(fresh);
    const after = getRedis();
    expect(after).toBe(fresh);
    expect(createRedisConnection).toHaveBeenCalledOnce();
  });

  it('closeRedis() is a no-op when no connection was ever created', async () => {
    await closeRedis(); // resets from the previous test — instance is now null
    await expect(closeRedis()).resolves.toBeUndefined();
  });

  it('closeRedis() swallows a rejected quit() (never throws on teardown)', async () => {
    const failing = { quit: vi.fn(async () => Promise.reject(new Error('ECONNRESET'))) };
    createRedisConnection.mockReturnValueOnce(failing);
    getRedis();

    await expect(closeRedis()).resolves.toBeUndefined();
    expect(failing.quit).toHaveBeenCalledOnce();
  });
});
