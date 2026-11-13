/**
 * Unit tests for the shared ioredis singleton used outside the BullMQ
 * queues (e.g. reading worker-owned bulk-upload counters).
 *
 * `@aggregator-dpg/queue`'s `createRedisConnection` is mocked so no real
 * Redis connection is opened. Covers lazy singleton construction, the test
 * override hook, and idempotent shutdown.
 *
 * @module @aggregator-dpg/api
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const createRedisConnectionMock = vi.fn();

vi.mock('@aggregator-dpg/queue', () => ({
  createRedisConnection: createRedisConnectionMock,
}));

describe('redis singleton', () => {
  beforeEach(() => {
    vi.resetModules();
    createRedisConnectionMock.mockReset();
  });

  it('builds the connection lazily on first call', async () => {
    const quit = vi.fn().mockResolvedValue(undefined);
    createRedisConnectionMock.mockReturnValue({ quit });
    const { getRedis } = await import('./index.js');
    const conn = getRedis();
    expect(conn).toBeDefined();
    expect(createRedisConnectionMock).toHaveBeenCalledTimes(1);
  });

  it('reuses the cached singleton across calls', async () => {
    const quit = vi.fn().mockResolvedValue(undefined);
    createRedisConnectionMock.mockReturnValue({ quit });
    const { getRedis } = await import('./index.js');
    const a = getRedis();
    const b = getRedis();
    expect(a).toBe(b);
    expect(createRedisConnectionMock).toHaveBeenCalledTimes(1);
  });

  it('_setRedis overrides the singleton for tests', async () => {
    const { getRedis, _setRedis } = await import('./index.js');
    const fake = { quit: vi.fn() } as unknown as ReturnType<typeof getRedis>;
    _setRedis(fake);
    expect(getRedis()).toBe(fake);
    expect(createRedisConnectionMock).not.toHaveBeenCalled();
  });

  it('closeRedis quits the connection and clears the singleton', async () => {
    const quit = vi.fn().mockResolvedValue(undefined);
    createRedisConnectionMock.mockReturnValue({ quit });
    const { getRedis, closeRedis } = await import('./index.js');
    getRedis();
    await closeRedis();
    expect(quit).toHaveBeenCalledTimes(1);
    // A subsequent getRedis() rebuilds — proves the singleton was cleared.
    getRedis();
    expect(createRedisConnectionMock).toHaveBeenCalledTimes(2);
  });

  it('closeRedis tolerates a quit() rejection (swallowed via .catch)', async () => {
    const quit = vi.fn().mockRejectedValue(new Error('already closed'));
    createRedisConnectionMock.mockReturnValue({ quit });
    const { getRedis, closeRedis } = await import('./index.js');
    getRedis();
    await expect(closeRedis()).resolves.toBeUndefined();
  });

  it('closeRedis is a no-op when no connection was ever built', async () => {
    const { closeRedis } = await import('./index.js');
    await expect(closeRedis()).resolves.toBeUndefined();
  });
});
