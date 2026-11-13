/**
 * Unit tests for the fixed-window Redis rate limiter.
 *
 * `@aggregator-dpg/queue`'s `createRedisConnection` is mocked with a fake
 * pipeline so no real Redis connection is opened. Covers the
 * allow/deny/retry-after math and the fail-open behaviour on a Redis error
 * (per error-handling.md — the public submit endpoint must not 5xx on a
 * Redis blip).
 *
 * @module @aggregator-dpg/api
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCreateRedisConnection } = vi.hoisted(() => ({
  mockCreateRedisConnection: vi.fn(),
}));

vi.mock('@aggregator-dpg/queue', () => ({
  createRedisConnection: mockCreateRedisConnection,
}));

function makeRedis(execResult: unknown, status: 'ready' | 'connecting' = 'ready') {
  const incrby = vi.fn().mockReturnThis();
  const expire = vi.fn().mockReturnThis();
  // Mirrors ioredis with `enableOfflineQueue: false`: a command issued before
  // the socket is ready throws rather than being buffered.
  const exec = vi.fn(async () => {
    if (redis.status !== 'ready') {
      throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
    }
    return execResult;
  });
  const multi = vi.fn(() => ({ incrby, expire, exec }));
  const decrby = vi.fn().mockResolvedValue(0);
  const on = vi.fn();
  const listeners = new Map<string, () => void>();
  const once = vi.fn((event: string, fn: () => void) => {
    listeners.set(event, fn);
  });
  const off = vi.fn((event: string) => {
    listeners.delete(event);
  });
  const quit = vi.fn().mockResolvedValue(undefined);
  /** Fires the pending `ready` listener, as ioredis would once connected. */
  const becomeReady = (): void => {
    redis.status = 'ready';
    listeners.get('ready')?.();
  };
  const redis = { multi, incrby, expire, exec, decrby, on, once, off, quit, status, becomeReady };
  return redis;
}

describe('rate-limiter consume', () => {
  beforeEach(() => {
    vi.resetModules();
    mockCreateRedisConnection.mockReset();
  });

  it('allows the first request in a window and reports its count', async () => {
    const redis = makeRedis([[null, 1]]);
    mockCreateRedisConnection.mockReturnValue(redis);
    const { consume } = await import('./index.js');
    const result = await consume({
      namespace: 'link-submit',
      key: 'slug1:1.2.3.4',
      windowSeconds: 60,
      max: 5,
    });
    expect(result).toEqual({ allowed: true, count: 1, retryAfterSeconds: 0 });
  });

  it('denies once the count exceeds max, with a positive retryAfterSeconds', async () => {
    const redis = makeRedis([[null, 6]]);
    mockCreateRedisConnection.mockReturnValue(redis);
    const { consume } = await import('./index.js');
    const result = await consume({
      namespace: 'link-submit',
      key: 'slug1:1.2.3.4',
      windowSeconds: 60,
      max: 5,
    });
    expect(result.allowed).toBe(false);
    expect(result.count).toBe(6);
    expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(result.retryAfterSeconds).toBeLessThanOrEqual(60);
    // Refund the slots the denied call consumed so the window isn't poisoned.
    expect(redis.decrby).toHaveBeenCalledWith(expect.stringContaining('rl:link-submit'), 1);
  });

  it('allows exactly at the max boundary (count === max)', async () => {
    const redis = makeRedis([[null, 5]]);
    mockCreateRedisConnection.mockReturnValue(redis);
    const { consume } = await import('./index.js');
    const result = await consume({
      namespace: 'link-submit',
      key: 'k',
      windowSeconds: 60,
      max: 5,
    });
    expect(result.allowed).toBe(true);
  });

  it('treats a malformed pipeline result as count 0 (allowed)', async () => {
    const redis = makeRedis([]);
    mockCreateRedisConnection.mockReturnValue(redis);
    const { consume } = await import('./index.js');
    const result = await consume({
      namespace: 'link-submit',
      key: 'k',
      windowSeconds: 60,
      max: 5,
    });
    expect(result).toEqual({ allowed: true, count: 0, retryAfterSeconds: 0 });
  });

  it('treats a null pipeline exec result as count 0 (allowed)', async () => {
    const redis = makeRedis(null);
    mockCreateRedisConnection.mockReturnValue(redis);
    const { consume } = await import('./index.js');
    const result = await consume({
      namespace: 'link-submit',
      key: 'k',
      windowSeconds: 60,
      max: 5,
    });
    expect(result).toEqual({ allowed: true, count: 0, retryAfterSeconds: 0 });
  });

  it('namespaces the Redis key by namespace, key, and window start', async () => {
    const redis = makeRedis([[null, 1]]);
    mockCreateRedisConnection.mockReturnValue(redis);
    const { consume } = await import('./index.js');
    await consume({ namespace: 'ns1', key: 'k1', windowSeconds: 60, max: 5 });
    const [incrKey, cost] = redis.incrby.mock.calls[0] as [string, number];
    expect(incrKey.startsWith('rl:ns1:k1:')).toBe(true);
    expect(cost).toBe(1);
    const [expireKey, ttl] = redis.expire.mock.calls[0] as [string, number];
    expect(expireKey).toBe(incrKey);
    expect(ttl).toBe(61);
  });

  it('consumes `cost` slots at once (bulk mint)', async () => {
    const redis = makeRedis([[null, 3]]);
    mockCreateRedisConnection.mockReturnValue(redis);
    const { consume } = await import('./index.js');
    const r = await consume({ namespace: 'ns', key: 'k', windowSeconds: 60, max: 5, cost: 3 });
    const [, cost] = redis.incrby.mock.calls[0] as [string, number];
    expect(cost).toBe(3);
    expect(r.allowed).toBe(true);
    expect(r.count).toBe(3);
  });

  it('fails open (allowed=true, count=0) and logs a warning when Redis throws', async () => {
    const redis = makeRedis(undefined);
    redis.exec.mockRejectedValue(new Error('ECONNREFUSED'));
    mockCreateRedisConnection.mockReturnValue(redis);
    const { consume } = await import('./index.js');
    const result = await consume({
      namespace: 'link-submit',
      key: 'k',
      windowSeconds: 60,
      max: 5,
    });
    expect(result).toEqual({ allowed: true, count: 0, retryAfterSeconds: 0 });
  });

  it('fails CLOSED (allowed=false) on a Redis error when failClosed is set', async () => {
    const redis = makeRedis(undefined);
    redis.exec.mockRejectedValue(new Error('ECONNREFUSED'));
    mockCreateRedisConnection.mockReturnValue(redis);
    const { consume } = await import('./index.js');
    const result = await consume({
      namespace: 'invite-mint',
      key: 'org-1',
      windowSeconds: 3600,
      max: 100,
      failClosed: true,
    });
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBe(3600);
  });

  it('reuses the cached Redis connection across calls', async () => {
    const redis = makeRedis([[null, 1]]);
    mockCreateRedisConnection.mockReturnValue(redis);
    const { consume } = await import('./index.js');
    await consume({ namespace: 'ns', key: 'k', windowSeconds: 60, max: 5 });
    await consume({ namespace: 'ns', key: 'k2', windowSeconds: 60, max: 5 });
    expect(mockCreateRedisConnection).toHaveBeenCalledTimes(1);
    expect(redis.on).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('registers a no-op error listener that never throws when invoked', async () => {
    const redis = makeRedis([[null, 1]]);
    mockCreateRedisConnection.mockReturnValue(redis);
    const { consume } = await import('./index.js');
    await consume({ namespace: 'ns', key: 'k', windowSeconds: 60, max: 5 });
    const errorHandler = redis.on.mock.calls.find((c) => c[0] === 'error')?.[1] as (
      e: Error,
    ) => void;
    expect(() => errorHandler(new Error('reconnect blip'))).not.toThrow();
  });

  it('closeRateLimiter quits the connection and clears the singleton', async () => {
    const redis = makeRedis([[null, 1]]);
    mockCreateRedisConnection.mockReturnValue(redis);
    const { consume, closeRateLimiter } = await import('./index.js');
    await consume({ namespace: 'ns', key: 'k', windowSeconds: 60, max: 5 });
    await closeRateLimiter();
    expect(redis.quit).toHaveBeenCalledTimes(1);
    await consume({ namespace: 'ns', key: 'k', windowSeconds: 60, max: 5 });
    expect(mockCreateRedisConnection).toHaveBeenCalledTimes(2);
  });

  it('closeRateLimiter tolerates a quit() rejection', async () => {
    const redis = makeRedis([[null, 1]]);
    redis.quit.mockRejectedValue(new Error('already closed'));
    mockCreateRedisConnection.mockReturnValue(redis);
    const { consume, closeRateLimiter } = await import('./index.js');
    await consume({ namespace: 'ns', key: 'k', windowSeconds: 60, max: 5 });
    await expect(closeRateLimiter()).resolves.toBeUndefined();
  });

  it('closeRateLimiter is a no-op when no connection was ever built', async () => {
    const { closeRateLimiter } = await import('./index.js');
    await expect(closeRateLimiter()).resolves.toBeUndefined();
  });

  it('waits for a connecting socket instead of denying the first call', async () => {
    // Reproduces the boot race: the connection is still coming up when the
    // first request arrives. `failClosed` makes a spurious deny visible.
    const redis = makeRedis([[null, 1]], 'connecting');
    mockCreateRedisConnection.mockReturnValue(redis);
    const { consume } = await import('./index.js');

    const pending = consume({
      namespace: 'invite-mint',
      key: 'org1',
      windowSeconds: 60,
      max: 5,
      failClosed: true,
    });
    redis.becomeReady();

    const result = await pending;
    expect(result.allowed).toBe(true);
    expect(result.count).toBe(1);
    expect(redis.exec).toHaveBeenCalledTimes(1);
  });

  it('builds the dedicated fail-fast connection options (not the BullMQ profile)', async () => {
    const redis = makeRedis([[null, 1]]);
    mockCreateRedisConnection.mockReturnValue(redis);
    const { consume } = await import('./index.js');
    await consume({ namespace: 'ns', key: 'k', windowSeconds: 60, max: 5 });
    expect(mockCreateRedisConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        maxRetriesPerRequest: 1,
        commandTimeout: 1000,
        enableOfflineQueue: false,
      }),
    );
  });
});
