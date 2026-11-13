/**
 * Injectable rate-limit check for the contact-support endpoint.
 *
 * Wraps the Redis limiter so route tests can set the outcome without Redis.
 *
 * Belongs to `@aggregator-dpg/api`.
 */

import { consume } from './rate-limiter/index.js';

/** Submissions allowed per coordinator per window; each may carry multi-MB uploads. */
export const SUPPORT_RATE_WINDOW_SECONDS = 3600;
export const SUPPORT_RATE_MAX_PER_WINDOW = 5;

export interface SupportRateResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

type Checker = (key: string) => Promise<SupportRateResult>;

let override: Checker | null = null;

/** Test helper; replaces the checker (null restores the Redis-backed default). */
export function _setSupportRateChecker(c: Checker | null): void {
  override = c;
}

/**
 * Consumes one slot for the given key from the support-submit bucket.
 *
 * @param key - Identifier inside the bucket (the authenticated user id).
 * @returns Whether the submission is allowed, and retry-after seconds.
 */
export async function checkSupportRate(key: string): Promise<SupportRateResult> {
  if (override) return override(key);
  const r = await consume({
    namespace: 'support-submit',
    key,
    windowSeconds: SUPPORT_RATE_WINDOW_SECONDS,
    max: SUPPORT_RATE_MAX_PER_WINDOW,
  });
  return { allowed: r.allowed, retryAfterSeconds: r.retryAfterSeconds };
}
