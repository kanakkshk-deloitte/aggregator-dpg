/**
 * URL string helpers shared across every aggregator process.
 *
 * @module @aggregator-dpg/shared-primitives
 */

/**
 * Removes every trailing `/` from a URL-ish string.
 *
 * Uses a loop instead of the regex `/\/+$/`, which backtracks slowly on long
 * input (SonarCloud typescript:S8786).
 *
 * @param value - The string to trim, e.g. a configured base or issuer URL.
 * @returns `value` with all trailing slashes removed; `''` if it was all slashes.
 */
export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charAt(end - 1) === '/') end -= 1;
  return end === value.length ? value : value.slice(0, end);
}
