/**
 * Self-contained path-resolution helpers for the web app.
 *
 * Mirrors `@aggregator-dpg/network-config/paths` so the web bundle does not
 * include that package. Keep both files in sync.
 *
 * Derivation rule:
 *   dir = `${CONFIG_ROOT}/${AGGREGATOR_NETWORK}[/${AGGREGATOR_BRAND}]`
 *   schemaRoot = SCHEMA_ROOT_DIR ?? `${dir}/schemas`
 *
 * @module apps/web/src/lib/config-paths
 */

import path from 'node:path';

/**
 * Resolves the active network/brand config directory from env vars.
 *
 * Defaults: `CONFIG_ROOT=/app/config`, `AGGREGATOR_NETWORK=blue_dot`.
 * Empty/whitespace `AGGREGATOR_BRAND` is treated as absent.
 *
 * @returns Absolute directory path for the active network/brand config.
 */
function resolveConfigDir(): string {
  const root = process.env.CONFIG_ROOT?.trim() || '/app/config';
  const net = process.env.AGGREGATOR_NETWORK?.trim() || 'blue_dot';
  const brand = process.env.AGGREGATOR_BRAND?.trim();
  return brand ? path.join(root, net, brand) : path.join(root, net);
}

/**
 * Resolves the schema root directory path.
 *
 * Returns `SCHEMA_ROOT_DIR` when explicitly set; otherwise derives
 * `<resolveConfigDir()>/schemas` from `AGGREGATOR_NETWORK`/`AGGREGATOR_BRAND`.
 *
 * @returns Absolute path to the `schemas/` directory.
 */
export function resolveSchemaRoot(): string {
  return process.env.SCHEMA_ROOT_DIR?.trim() || path.join(resolveConfigDir(), 'schemas');
}

/**
 * Returns the candidate locations of an aggregator schema file inside a
 * `config/` root, most specific first.
 *
 * Callers use the first path that exists. A network or brand overrides the
 * shared default by placing a complete copy of the file at
 * `<network>[/<brand>]/schemas/aggregator/<file>`.
 *
 * Mirrors `aggregatorSchemaRelPaths` in `packages/network-config/src/paths.ts`;
 * keep both in sync.
 *
 * @param file - Bare schema file name, e.g. `registration.v1.json`.
 * @returns Root-relative paths, most specific first.
 */
export function aggregatorSchemaRelPaths(file: string): string[] {
  const net = process.env.AGGREGATOR_NETWORK?.trim() || 'blue_dot';
  const brand = process.env.AGGREGATOR_BRAND?.trim();
  // Most specific first.
  const relPath = (...prefix: string[]): string =>
    path.join(...prefix, 'schemas', 'aggregator', file);
  return brand ? [relPath(net, brand), relPath(net), relPath()] : [relPath(net), relPath()];
}
