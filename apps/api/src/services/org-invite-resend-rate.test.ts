/**
 * Unit tests for the org invite-resend rate check.
 *
 * The posture is the point of this service, so it is asserted directly rather
 * than only through the route: keyed on the owner address alone, and
 * FAIL-CLOSED, because every admitted call mints another independent 90-day
 * grant. `@aggregator-dpg/queue`'s Redis connection is mocked so no socket
 * opens; the harness mirrors `rate-limiter/index.test.ts`.
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

/** Redis double whose pipeline `exec` resolves to `execResult`. */
function makeRedis(execResult: unknown) {
  const incrby = vi.fn().mockReturnThis();
  const expire = vi.fn().mockReturnThis();
  const exec = vi.fn().mockResolvedValue(execResult);
  const multi = vi.fn(() => ({ incrby, expire, exec }));
  // `status` mirrors ioredis: consume() waits for a connecting socket.
  return {
    multi,
    incrby,
    expire,
    exec,
    decrby: vi.fn(),
    on: vi.fn(),
    quit: vi.fn(),
    status: 'ready',
  };
}

describe('checkOrgInviteResendRate', () => {
  beforeEach(() => {
    vi.resetModules();
    mockCreateRedisConnection.mockReset();
  });

  it('allows a first resend for an owner address', async () => {
    mockCreateRedisConnection.mockReturnValue(makeRedis([[null, 1]]));
    const { checkOrgInviteResendRate } = await import('./org-invite-resend-rate.js');
    const r = await checkOrgInviteResendRate('owner@enable.org');
    expect(r.allowed).toBe(true);
  });

  it('denies once the window cap is exceeded, with a retry-after', async () => {
    mockCreateRedisConnection.mockReturnValue(makeRedis([[null, 99]]));
    const { checkOrgInviteResendRate } = await import('./org-invite-resend-rate.js');
    const r = await checkOrgInviteResendRate('owner@enable.org');
    expect(r.allowed).toBe(false);
    expect(r.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('FAILS CLOSED when Redis is unavailable', async () => {
    // The whole reason this service exists rather than reusing the route's
    // fail-open submit limiter: a Redis outage must not remove the cap from a
    // path where each admitted call mints an unrevocable 90-day credential.
    const redis = makeRedis(null);
    redis.exec = vi.fn().mockRejectedValue(new Error('redis down'));
    redis.multi = vi.fn(() => ({ incrby: redis.incrby, expire: redis.expire, exec: redis.exec }));
    mockCreateRedisConnection.mockReturnValue(redis);
    const { checkOrgInviteResendRate } = await import('./org-invite-resend-rate.js');
    const r = await checkOrgInviteResendRate('owner@enable.org');
    expect(r.allowed).toBe(false);
  });

  it('normalises the key so casing cannot buy a second bucket', async () => {
    const redis = makeRedis([[null, 1]]);
    mockCreateRedisConnection.mockReturnValue(redis);
    const { checkOrgInviteResendRate } = await import('./org-invite-resend-rate.js');
    await checkOrgInviteResendRate('Owner@Enable.ORG');
    const keys = redis.incrby.mock.calls.map((c) => String(c[0]));
    expect(keys.some((k) => k.includes('owner@enable.org'))).toBe(true);
    expect(keys.some((k) => k.includes('Owner@Enable.ORG'))).toBe(false);
  });

  it('honours the injected override, so routes stay testable without Redis', async () => {
    const { checkOrgInviteResendRate, _setOrgInviteResendRateChecker } =
      await import('./org-invite-resend-rate.js');
    _setOrgInviteResendRateChecker(async () => ({ allowed: false, retryAfterSeconds: 42 }));
    const r = await checkOrgInviteResendRate('owner@enable.org');
    expect(r).toEqual({ allowed: false, retryAfterSeconds: 42 });
    _setOrgInviteResendRateChecker(null);
  });
});
