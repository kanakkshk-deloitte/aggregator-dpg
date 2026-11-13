/**
 * Unit tests for {@link acquireRayaSlot} — the fail-closed Redis egress gate
 * bounding our call rate against Raya's ~1 call/20s limit.
 *
 * Unlike the API's rate limiter (fails OPEN on a Redis error, per
 * `apps/api/src/services/rate-limiter`), this gate is deliberately
 * fail-CLOSED: a Redis error means we cannot verify we're under the
 * provider's rate limit, so the safest behaviour is to wait out a full
 * window before letting the caller proceed, rather than risk hammering
 * Raya and getting the whole batch throttled or banned.
 *
 * `redis`, `sleep`, and `now` are all injected so the gate is testable
 * without a real Redis connection or real wall-clock waits.
 *
 * @module @aggregator-dpg/voice-provider
 */
import { describe, it, expect, vi } from 'vitest';
import { acquireRayaSlot } from '../egress.js';

/** Minimal fake matching the `multi().incr().expire().exec()` shape egress.ts uses. */
function makeRedis(execResults: unknown[]) {
  const exec = vi.fn();
  for (const r of execResults) exec.mockResolvedValueOnce(r);
  const incr = vi.fn().mockReturnThis();
  const expire = vi.fn().mockReturnThis();
  const multiObj = { incr, expire, exec };
  const multi = vi.fn(() => multiObj);
  return { multi, incr, expire, exec };
}

describe('acquireRayaSlot', () => {
  it('returns immediately for the first slot in a window, without sleeping', async () => {
    const redis = makeRedis([[[null, 1]]]);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const now = () => Date.parse('2026-08-26T00:00:00.000Z');

    // exec() resolves an ioredis multi pipeline result: an array of [err, value] tuples.
    redis.exec.mockReset();
    redis.exec.mockResolvedValueOnce([[null, 1]]);

    await acquireRayaSlot({ redis: redis as never, windowSeconds: 20, max: 1, sleep, now });

    expect(sleep).not.toHaveBeenCalled();
  });

  it('waits out the window before proceeding when the window is already full', async () => {
    const redis = makeRedis([]);
    redis.exec
      .mockResolvedValueOnce([[null, 2]]) // first attempt: over max
      .mockResolvedValueOnce([[null, 1]]); // retry after sleeping: under max
    const sleep = vi.fn().mockResolvedValue(undefined);
    const now = () => Date.parse('2026-08-26T00:00:05.000Z');

    await acquireRayaSlot({ redis: redis as never, windowSeconds: 20, max: 1, sleep, now });

    expect(sleep).toHaveBeenCalledTimes(1);
    // Window boundary for a 20s window starting at :00 is :20 — 5s in means a
    // 15s wait.
    expect(sleep).toHaveBeenCalledWith(15000);
  });

  it('fails closed: sleeps a full window and proceeds when Redis errors', async () => {
    const redis = makeRedis([]);
    redis.exec.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const now = () => Date.now();

    await acquireRayaSlot({ redis: redis as never, windowSeconds: 20, max: 1, sleep, now });

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(20000);
  });

  it('does not retry Redis after a fail-closed sleep — proceeds unconditionally', async () => {
    const redis = makeRedis([]);
    redis.exec.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const now = () => Date.now();

    await acquireRayaSlot({ redis: redis as never, windowSeconds: 20, max: 1, sleep, now });

    // Only the one (failed) attempt — no second call to redis.multi() to
    // re-check the count after the fail-closed wait.
    expect(redis.multi).toHaveBeenCalledTimes(1);
  });

  it('fails closed on a malformed multi-exec result (no numeric INCR reply) instead of granting an immediate slot', async () => {
    const redis = makeRedis([]);
    // Not the [[err, value], ...] shape acquireRayaSlot expects — e.g. exec()
    // resolved null (as ioredis does when a WATCH aborts the transaction).
    // C2: this must NOT default to count=0 (an immediate grant) — it's
    // exactly as unverifiable as a thrown Redis error.
    redis.exec.mockResolvedValueOnce(null);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const now = () => Date.now();

    await acquireRayaSlot({ redis: redis as never, windowSeconds: 20, max: 1, sleep, now });

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(20000);
  });

  it('fails closed when multi().exec() resolves a per-command error tuple ([Error, null]) for INCR — C2', async () => {
    const redis = makeRedis([]);
    // ioredis RESOLVES (never rejects) a pipelined command failure like
    // READONLY/OOM as an `[Error, null]` tuple inside the exec() array — the
    // old code read `incrEntry[1]` (null, not a number) and fell back to
    // `count = 0`, granting an immediate slot despite being unable to verify
    // the window's count. Must sleep a full window instead, same as the
    // thrown-error path.
    redis.exec.mockResolvedValueOnce([[new Error('READONLY'), null]]);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const now = () => Date.now();

    await acquireRayaSlot({ redis: redis as never, windowSeconds: 20, max: 1, sleep, now });

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(20000);
  });

  it('uses the real defaultSleep/Date.now when sleep/now are not injected', async () => {
    vi.useFakeTimers();
    try {
      const redis = makeRedis([]);
      redis.exec
        .mockResolvedValueOnce([[null, 2]]) // over max
        .mockResolvedValueOnce([[null, 1]]); // under max after the wait

      const acquired = acquireRayaSlot({ redis: redis as never, windowSeconds: 20, max: 1 });
      // Give the first `redis.multi().exec()` microtask a chance to resolve
      // and reach the real `setTimeout`-backed sleep.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(20_000);
      await acquired;

      expect(redis.multi).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
