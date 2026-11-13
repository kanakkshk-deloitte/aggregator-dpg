import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// RedisSessionStore reaches for a real ioredis singleton by default
// (lazyConnect: false), which would try to open a live TCP connection in
// this unit test. Stub the client factory so `new RedisSessionStore()`
// stays offline — we only assert on the constructed type here.
vi.mock('@/lib/session/redis-client', () => ({
  getRedisClient: () => ({ set: vi.fn(), get: vi.fn(), expire: vi.fn(), del: vi.fn() }),
}));

describe('getSessionStore', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.REDIS_URL;
    delete process.env.SESSION_TTL_SECONDS;
  });

  it('returns a MemorySessionStore when REDIS_URL is unset', async () => {
    delete process.env.REDIS_URL;
    const { getSessionStore } = await import('@/lib/session');
    const { MemorySessionStore } = await import('@/lib/session/memory');
    expect(getSessionStore()).toBeInstanceOf(MemorySessionStore);
  });

  it('returns a RedisSessionStore when REDIS_URL is set', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    const { getSessionStore } = await import('@/lib/session');
    const { RedisSessionStore } = await import('@/lib/session/redis');
    expect(getSessionStore()).toBeInstanceOf(RedisSessionStore);
  });

  it('returns the same singleton on repeated calls', async () => {
    const { getSessionStore } = await import('@/lib/session');
    expect(getSessionStore()).toBe(getSessionStore());
  });

  it('_resetSessionStore forces a fresh instance', async () => {
    const { getSessionStore, _resetSessionStore } = await import('@/lib/session');
    const first = getSessionStore();
    _resetSessionStore();
    const second = getSessionStore();
    expect(first).not.toBe(second);
  });
});
