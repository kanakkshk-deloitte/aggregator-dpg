/**
 * Unit tests for the per-actor console-write rate limiter.
 *
 * Covers the test-override short-circuit and the real Redis-backed `consume`
 * path. `@aggregator-dpg/queue`'s `createRedisConnection` is mocked with a fake
 * pipeline (as the rate-limiter's own tests do) so no real Redis is opened; the
 * module registry is reset per test so the rate limiter's cached connection
 * never leaks between cases.
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

function makeRedis(execResult: unknown) {
  const incrby = vi.fn().mockReturnThis();
  const expire = vi.fn().mockReturnThis();
  const exec = vi.fn().mockResolvedValue(execResult);
  const multi = vi.fn(() => ({ incrby, expire, exec }));
  const decrby = vi.fn().mockResolvedValue(0);
  const on = vi.fn();
  const quit = vi.fn().mockResolvedValue(undefined);
  // `status` mirrors ioredis: consume() waits for a connecting socket.
  return { multi, incrby, expire, exec, decrby, on, quit, status: 'ready' };
}

describe('checkConsoleWriteRate', () => {
  beforeEach(() => {
    vi.resetModules();
    mockCreateRedisConnection.mockReset();
  });

  it('delegates to an installed override and skips Redis', async () => {
    const { checkConsoleWriteRate, _setConsoleWriteRateChecker } =
      await import('./console-rate.js');
    const checker = vi.fn(async () => ({ allowed: false, retryAfterSeconds: 42 }));
    _setConsoleWriteRateChecker(checker);
    const r = await checkConsoleWriteRate('actor-1');
    expect(r).toEqual({ allowed: false, retryAfterSeconds: 42 });
    expect(checker).toHaveBeenCalledWith('actor-1');
    expect(mockCreateRedisConnection).not.toHaveBeenCalled();
    _setConsoleWriteRateChecker(null);
  });

  it('consumes a real slot via Redis when no override is set (allowed)', async () => {
    const redis = makeRedis([[null, 1]]);
    mockCreateRedisConnection.mockReturnValue(redis);
    const { checkConsoleWriteRate } = await import('./console-rate.js');
    const r = await checkConsoleWriteRate('actor-2');
    expect(r).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(redis.multi).toHaveBeenCalled();
  });

  it('reports a denied slot with a retry-after once the window is exhausted', async () => {
    const redis = makeRedis([[null, 61]]);
    mockCreateRedisConnection.mockReturnValue(redis);
    const { checkConsoleWriteRate } = await import('./console-rate.js');
    const r = await checkConsoleWriteRate('actor-3');
    expect(r.allowed).toBe(false);
    expect(r.retryAfterSeconds).toBeGreaterThan(0);
  });
});
