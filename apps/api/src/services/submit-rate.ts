/**
 * Injectable rate-limit check for the coordinator registration endpoint.
 *
 * Belongs to `@aggregator-dpg/api`. Wraps the Redis limiter so routes can be
 * tested without Redis; tests override it with `_setSubmitRateChecker`.
 */

import { config } from '../config.js';
import { consume } from './rate-limiter/index.js';

export interface SubmitRateResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

type Checker = (key: string) => Promise<SubmitRateResult>;

let override: Checker | null = null;

/** Test helper; replaces the checker (null restores the Redis-backed default). */
export function _setSubmitRateChecker(c: Checker | null): void {
  override = c;
}

/**
 * Consumes one slot for the given key (typically `${ip}|${email}`) from the
 * coordinator-submit bucket.
 *
 * @param key - Identifier inside the bucket (per-IP and/or per-email).
 * @returns Whether the call is allowed, and retry-after seconds.
 */
export async function checkSubmitRate(key: string): Promise<SubmitRateResult> {
  if (override) return override(key);
  const r = await consume({
    namespace: 'coordinator-submit',
    key,
    windowSeconds: config.PUBLIC_SUBMIT_RATE_WINDOW_SECONDS,
    max: config.PUBLIC_SUBMIT_RATE_MAX_PER_WINDOW,
  });
  return { allowed: r.allowed, retryAfterSeconds: r.retryAfterSeconds };
}
