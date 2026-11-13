/**
 * Lifecycle resolver for signals items (`@aggregator-dpg/api`).
 *
 * Aggregator-facing reads must use this helper so that a missing or unknown
 * status is treated as `draft`, never `live`.
 *
 * @packageDocumentation
 * @module @aggregator-dpg/api/services/onboarding/lifecycle
 */

/**
 * Canonical tuple of lifecycle states a signals item can be in.
 *
 * Use it for Zod enums (`z.enum(LIFECYCLE_STATUSES)`) and membership checks.
 */
export const LIFECYCLE_STATUSES = ['draft', 'live', 'paused', 'retired'] as const;

/**
 * The set of lifecycle states a signals item can be in.
 *
 * Matches the signals-stack `lifecycle_status` column.
 */
export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];

const VALID = new Set<LifecycleStatus>(LIFECYCLE_STATUSES);

/**
 * Resolves the lifecycle for a signals item, applying the back-compat rule.
 *
 * Resolution rules, in order:
 * 1. `null` / `undefined` item → `null` (no item present).
 * 2. `lifecycle_status` missing → `'draft'`.
 * 3. `lifecycle_status` is a known value → returned as-is.
 * 4. `lifecycle_status` is an unknown string → `'draft'`.
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
  if (raw === undefined) return 'draft';
  return VALID.has(raw as LifecycleStatus) ? (raw as LifecycleStatus) : 'draft';
}
