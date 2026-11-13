/**
 * CSPRNG-backed uniform random source for the aggregator web app.
 *
 * `Math.random()` is banned repo-wide. This module reads 32-bit words from
 * `crypto.getRandomValues` in blocks and returns them as floats, so callers
 * do not pay one CSPRNG call per value.
 *
 * @module @aggregator-dpg/web
 */

/** 32-bit words drawn per refill; one block covers ~28 particles. */
const POOL_WORDS = 256;

/** 2^32 — divisor that maps a Uint32 onto the half-open interval [0, 1). */
const UINT32_RANGE = 4_294_967_296;

const pool = new Uint32Array(POOL_WORDS);
let cursor = POOL_WORDS;

/**
 * Returns a uniformly distributed float in the half-open interval [0, 1).
 *
 * Drop-in replacement for `Math.random()`, backed by the platform CSPRNG.
 *
 * @returns A float `n` such that `0 <= n < 1`.
 */
export function randomUnit(): number {
  if (cursor >= POOL_WORDS) {
    crypto.getRandomValues(pool);
    cursor = 0;
  }
  const word = pool[cursor] ?? 0;
  cursor += 1;
  return word / UINT32_RANGE;
}
