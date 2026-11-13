/**
 * Deterministic ordering for capability keys, role keys and reason codes,
 * part of `@aggregator-dpg/rbac`.
 *
 * @module @aggregator-dpg/rbac/order
 */

/**
 * Orders two strings by UTF-16 code unit, the default `Array.prototype.sort()`
 * order. Keeps sorted outputs stable and locale-independent.
 *
 * @param a - First string.
 * @param b - Second string.
 * @returns Negative when `a` sorts first, positive when `b` does, else 0.
 */
export function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
