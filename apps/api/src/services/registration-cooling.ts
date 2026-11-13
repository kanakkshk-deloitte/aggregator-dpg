/**
 * Rejection cooling-window helper for `@aggregator-dpg/api`.
 *
 * A rejected coordinator or org cannot re-register until
 * `REGISTRATION_COOLING_MINUTES` (default 720) has passed. The window runs
 * from the write-once `rejected_at`, not `updated_at`. After it, the caller
 * revives the same row.
 */

import { config } from '../config.js';

/**
 * Computes the cooling-window verdict for a rejected registration row.
 *
 * @param rejectedAt - Write-once reject timestamp; `null` falls back to `updatedAt`.
 * @param updatedAt - The row's last-updated timestamp.
 * @returns ISO retry-after timestamp while still cooling, or `null` once the
 *   window has elapsed and re-registration is permitted.
 */
export function coolingRetryAfter(rejectedAt: Date | null, updatedAt: Date): string | null {
  const rejectedRef = rejectedAt ?? updatedAt;
  const windowMs = config.REGISTRATION_COOLING_MINUTES * 60_000;
  const readyAt = rejectedRef.getTime() + windowMs;
  return Date.now() < readyAt ? new Date(readyAt).toISOString() : null;
}
