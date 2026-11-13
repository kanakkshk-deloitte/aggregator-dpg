/**
 * Fail-closed Redis gate that keeps outbound calls under a voice provider's
 * rate limit.
 *
 * Uses a fixed-window `INCR`+`EXPIRE` counter on `raya:egress:{windowStart}`.
 * On a Redis error it fails closed: it waits one full window, then lets the
 * caller proceed. This protects the provider's budget while Redis is down.
 *
 * `redis`, `sleep`, and `now` are injectable for tests.
 *
 * @module @aggregator-dpg/voice-provider
 */

import type { Redis } from 'ioredis';

/**
 * Dependencies for {@link acquireRayaSlot}.
 */
export interface AcquireRayaSlotDeps {
  /** Redis client used for the fixed-window counter. */
  redis: Redis;
  /** Window length in seconds (Raya's budget is expressed per this window). */
  windowSeconds: number;
  /** Maximum calls allowed per window. */
  max: number;
  /** Sleep function; defaults to a real `setTimeout`-backed wait. Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock function; defaults to `Date.now`. Injectable for tests. */
  now?: () => number;
}

/**
 * Waits for a free slot under the provider's rate limit, then returns.
 *
 * Call it immediately before each Raya create or start call. When the
 * current window is full, it sleeps until the next window and retries.
 *
 * If the count cannot be read (Redis error, or a missing or failed `INCR`
 * result), it sleeps one full window and returns. It never treats an
 * unreadable count as zero.
 *
 * @param deps - Redis client, window/max budget, and injectable sleep/clock.
 */
export async function acquireRayaSlot(deps: AcquireRayaSlotDeps): Promise<void> {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;

  for (;;) {
    const nowMs = now();
    const windowStart = Math.floor(nowMs / 1000 / deps.windowSeconds) * deps.windowSeconds;
    const key = `raya:egress:${windowStart}`;

    let count: number;
    try {
      // INCR and EXPIRE run together so a counter never lacks a TTL.
      const execResult = await deps.redis
        .multi()
        .incr(key)
        .expire(key, deps.windowSeconds + 1)
        .exec();
      const incrEntry = execResult?.[0];
      const incrError = Array.isArray(incrEntry) ? incrEntry[0] : undefined;
      const incrValue = Array.isArray(incrEntry) ? incrEntry[1] : undefined;
      // `exec()` reports a failed command as an `[Error, null]` tuple instead
      // of throwing. Fail closed on that, as on a thrown error.
      if (incrError != null || typeof incrValue !== 'number') {
        await sleep(deps.windowSeconds * 1000);
        return;
      }
      count = incrValue;
    } catch {
      // Fail closed: wait one full window before proceeding.
      await sleep(deps.windowSeconds * 1000);
      return;
    }

    if (count <= deps.max) return;

    const nowSeconds = Math.floor(nowMs / 1000);
    const waitMs = Math.max(0, (windowStart + deps.windowSeconds - nowSeconds) * 1000);
    await sleep(waitMs);
  }
}

/**
 * Default `setTimeout`-based sleep, used when no `sleep` is injected.
 *
 * @param ms - Milliseconds to wait.
 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
