/**
 * Back-compat aware lifecycle resolver.
 *
 * Signals may not have shipped the lifecycle column to every environment
 * yet. Any aggregator-facing read MUST go through this helper so the
 * fallback rule "absent → live" is enforced in one place.
 *
 * @packageDocumentation
 * @module @aggregator-dpg/api/services/onboarding/lifecycle
 */

/**
 * Canonical tuple of lifecycle states a signals item can be in.
 *
 * Single source of truth for the literal list — use it to build Zod enums
 * (`z.enum(LIFECYCLE_STATUSES)`) or membership checks instead of
 * re-declaring `['draft', 'live', 'paused', 'retired']` locally.
 */
export const LIFECYCLE_STATUSES = ['draft', 'live', 'paused', 'retired'] as const;

/**
 * The set of lifecycle states a signals item can be in.
 *
 * Mirrors the `lifecycle_status` column shipped by signals-stack. Kept as a
 * string literal union (not a Zod schema) because the helper must be cheap
 * to call from any hot read path.
 */
export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];

const VALID = new Set<LifecycleStatus>(LIFECYCLE_STATUSES);

/**
 * Resolves the lifecycle for a signals item, applying the back-compat rule.
 *
 * Resolution rules, in order:
 * 1. `null` / `undefined` item → `null` (no item present).
 * 2. `lifecycle_status` missing on the item → `'live'` (back-compat default).
 * 3. `lifecycle_status` is a known value → returned as-is.
 * 4. `lifecycle_status` is an unknown string → `'live'` (defensive clamp).
 *
 * Always prefer this helper over reading `item.lifecycle_status` directly so
 * the fallback behaviour stays consistent across the codebase.
 *
 * @param item - The signals item slice; only `lifecycle_status` is read.
 *               Pass `null` or `undefined` for "no item present".
 * @returns `'draft' | 'live' | 'paused' | 'retired'`, or `null` when item is null/undefined.
 */
export function resolveLifecycle(
  item: { lifecycle_status?: LifecycleStatus | string } | null | undefined,
): LifecycleStatus | null {
  if (item == null) return null;
  const raw = item.lifecycle_status;
  if (raw === undefined) return 'live';
  return VALID.has(raw as LifecycleStatus) ? (raw as LifecycleStatus) : 'live';
}
