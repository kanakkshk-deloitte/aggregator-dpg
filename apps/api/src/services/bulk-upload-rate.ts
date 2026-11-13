/**
 * Injectable rate-limit checks for the bulk-upload surface.
 *
 * Wraps the Redis fixed-window limiter so route tests can set the outcome
 * without Redis. The real limiter fails open.
 *
 * Uploads and template builds use separate buckets because they have
 * different costs.
 *
 * Belongs to `@aggregator-dpg/api`.
 */

import { consume } from './rate-limiter/index.js';

/** Uploads allowed per coordinator per window. */
export const BULK_UPLOAD_RATE_WINDOW_SECONDS = 3600;
export const BULK_UPLOAD_RATE_MAX_PER_WINDOW = 5;

/** Template builds allowed per coordinator per window. Each call renders a workbook. */
export const BULK_TEMPLATE_RATE_WINDOW_SECONDS = 3600;
export const BULK_TEMPLATE_RATE_MAX_PER_WINDOW = 30;

export interface BulkUploadRateResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

type Checker = (key: string) => Promise<BulkUploadRateResult>;

let uploadOverride: Checker | null = null;
let templateOverride: Checker | null = null;

/** Test helper — replace the upload checker (null restores the Redis-backed default). */
export function _setBulkUploadRateChecker(c: Checker | null): void {
  uploadOverride = c;
}

/** Test helper — replace the template checker (null restores the Redis-backed default). */
export function _setBulkTemplateRateChecker(c: Checker | null): void {
  templateOverride = c;
}

/**
 * Consumes one slot for the given key from the bulk-upload bucket.
 *
 * @param key - Identifier inside the bucket (the authenticated user id).
 * @returns Whether the upload is allowed + retry-after seconds.
 */
export async function checkBulkUploadRate(key: string): Promise<BulkUploadRateResult> {
  if (uploadOverride) return uploadOverride(key);
  const r = await consume({
    namespace: 'bulk-upload',
    key,
    windowSeconds: BULK_UPLOAD_RATE_WINDOW_SECONDS,
    max: BULK_UPLOAD_RATE_MAX_PER_WINDOW,
  });
  return { allowed: r.allowed, retryAfterSeconds: r.retryAfterSeconds };
}

/**
 * Consumes one slot for the given key from the bulk-template bucket.
 *
 * @param key - Identifier inside the bucket (the authenticated user id).
 * @returns Whether the template build is allowed + retry-after seconds.
 */
export async function checkBulkTemplateRate(key: string): Promise<BulkUploadRateResult> {
  if (templateOverride) return templateOverride(key);
  const r = await consume({
    namespace: 'bulk-template',
    key,
    windowSeconds: BULK_TEMPLATE_RATE_WINDOW_SECONDS,
    max: BULK_TEMPLATE_RATE_MAX_PER_WINDOW,
  });
  return { allowed: r.allowed, retryAfterSeconds: r.retryAfterSeconds };
}
