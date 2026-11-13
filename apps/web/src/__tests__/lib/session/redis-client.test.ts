import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

interface FakeRedisInstance {
  url: string;
  options: unknown;
  quit: ReturnType<typeof vi.fn>;
}

const instances: FakeRedisInstance[] = [];

vi.mock('ioredis', () => {
  class FakeRedis {
    url: string;
    options: unknown;
    quit = vi.fn().mockResolvedValue('OK');
    constructor(url: string, options: unknown) {
      this.url = url;
      this.options = options;
      instances.push(this as unknown as FakeRedisInstance);
    }
  }
  return { default: FakeRedis };
});

describe('getRedisClient / closeRedisClient', () => {
  beforeEach(async () => {
    vi.resetModules();
    instances.length = 0;
    delete process.env.REDIS_URL;
    const mod = await import('@/lib/session/redis-client');
    mod._setRedisClient(null);
  });

  afterEach(() => {
    delete process.env.REDIS_URL;
  });

  it('creates a client from the REDIS_URL env var by default', async () => {
    process.env.REDIS_URL = 'redis://cache-host:6379';
    const { getRedisClient } = await import('@/lib/session/redis-client');
    const client = getRedisClient() as unknown as FakeRedisInstance;
    expect(client.url).toBe('redis://cache-host:6379');
  });

  it('falls back to localhost when no URL is given or configured', async () => {
    const { getRedisClient } = await import('@/lib/session/redis-client');
    const client = getRedisClient() as unknown as FakeRedisInstance;
    expect(client.url).toBe('redis://localhost:6379');
  });

  it('prefers an explicit url argument over the env var', async () => {
    process.env.REDIS_URL = 'redis://env-host:6379';
    const { getRedisClient } = await import('@/lib/session/redis-client');
    const client = getRedisClient('redis://explicit-host:6379') as unknown as FakeRedisInstance;
    expect(client.url).toBe('redis://explicit-host:6379');
  });

  it('returns the same singleton on repeated calls', async () => {
    const { getRedisClient } = await import('@/lib/session/redis-client');
    expect(getRedisClient()).toBe(getRedisClient());
    expect(instances).toHaveLength(1);
  });

  it('closeRedisClient quits the client and clears the singleton', async () => {
    const { getRedisClient, closeRedisClient } = await import('@/lib/session/redis-client');
    const client = getRedisClient() as unknown as FakeRedisInstance;
    await closeRedisClient();
    expect(client.quit).toHaveBeenCalledOnce();
    const next = getRedisClient() as unknown as FakeRedisInstance;
    expect(next).not.toBe(client);
  });

  it('closeRedisClient is a no-op when no client exists', async () => {
    const { closeRedisClient } = await import('@/lib/session/redis-client');
    await expect(closeRedisClient()).resolves.toBeUndefined();
  });

  it('throws if getRedisClient is called again while shutting down', async () => {
    const { getRedisClient, closeRedisClient } = await import('@/lib/session/redis-client');
    getRedisClient();
    // Don't await — exercise the `closing` guard window synchronously.
    const closing = closeRedisClient();
    expect(() => getRedisClient()).toThrow(/shutting down/);
    await closing;
  });

  it('_setRedisClient injects a client for tests', async () => {
    const { getRedisClient, _setRedisClient } = await import('@/lib/session/redis-client');
    const injected = { url: 'injected', options: {}, quit: vi.fn() };
    _setRedisClient(injected as never);
    expect(getRedisClient()).toBe(injected as never);
  });
});
