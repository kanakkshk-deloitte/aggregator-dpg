/**
 * Path helpers for the network-config package.
 *
 * Derive the config and schema paths from `AGGREGATOR_NETWORK` and
 * `AGGREGATOR_BRAND`. `AGGREGATOR_CONFIG_PATH` and `SCHEMA_ROOT_DIR`
 * override the derived values when set.
 *
 * Derivation rule:
 *   dir = `${CONFIG_ROOT}/${AGGREGATOR_NETWORK}[/${AGGREGATOR_BRAND}]`
 *   configPath = AGGREGATOR_CONFIG_PATH ?? `${dir}/aggregator.config.yaml`
 *   schemaRoot = SCHEMA_ROOT_DIR ?? `${dir}/schemas`
 *
 * @module packages/network-config/src/paths
 */

import path from 'node:path';

/**
 * Subset of `process.env` read by the path helpers.
 *
 * Tests pass their own object instead of changing `process.env`.
 */
export interface ConfigPathEnv {
  CONFIG_ROOT?: string;
  AGGREGATOR_NETWORK?: string;
  AGGREGATOR_BRAND?: string;
  AGGREGATOR_CONFIG_PATH?: string;
  SCHEMA_ROOT_DIR?: string;
  AGGREGATOR_NETWORK_SOURCE?: string;
  AGGREGATOR_PARTICIPANT_CONSENT_SOURCE?: string;
}

/**
 * Reads the `AGGREGATOR_NETWORK_SOURCE` override for the `network.json` URL.
 *
 * When set, it replaces `aggregator.network.source` from the YAML.
 *
 * @param env - Env-var bag; defaults to `process.env`.
 * @returns The override URL, or `undefined` when unset/blank.
 */
export function resolveNetworkSourceOverride(env: ConfigPathEnv = process.env): string | undefined {
  const value = env.AGGREGATOR_NETWORK_SOURCE?.trim();
  return value || undefined;
}

/**
 * Reads the `AGGREGATOR_PARTICIPANT_CONSENT_SOURCE` override for the consent URL.
 *
 * When set, it replaces `aggregator.network.consent_source` from the YAML.
 *
 * @param env - Env-var bag; defaults to `process.env`.
 * @returns The override URL, or `undefined` when unset/blank.
 */
export function resolveConsentSourceOverride(env: ConfigPathEnv = process.env): string | undefined {
  const value = env.AGGREGATOR_PARTICIPANT_CONSENT_SOURCE?.trim();
  return value || undefined;
}

/**
 * Resolves the active network/brand config directory from env vars.
 *
 * Defaults: `CONFIG_ROOT=/app/config`, `AGGREGATOR_NETWORK=blue_dot`.
 * Empty/whitespace `AGGREGATOR_BRAND` is treated as absent (no brand suffix).
 *
 * @param env - Env-var bag; defaults to `process.env`.
 * @returns Absolute directory path for the active network/brand config.
 */
export function resolveConfigDir(env: ConfigPathEnv = process.env): string {
  const root = resolveConfigRoot(env);
  const net = env.AGGREGATOR_NETWORK?.trim() || 'blue_dot';
  const brand = env.AGGREGATOR_BRAND?.trim();
  return brand ? path.join(root, net, brand) : path.join(root, net);
}

/**
 * Resolves the config root, which holds every network folder and the shared defaults.
 *
 * {@link resolveConfigDir} returns the active network folder under this root.
 *
 * @param env - Env-var bag; defaults to `process.env`.
 * @returns Absolute path to the config root. Default: `/app/config`.
 */
export function resolveConfigRoot(env: ConfigPathEnv = process.env): string {
  return env.CONFIG_ROOT?.trim() || '/app/config';
}

/**
 * Resolves the aggregator config YAML path.
 *
 * Returns `AGGREGATOR_CONFIG_PATH` when explicitly set; otherwise derives
 * `<resolveConfigDir(env)>/aggregator.config.yaml`.
 *
 * @param env - Env-var bag; defaults to `process.env`.
 * @returns Absolute path to `aggregator.config.yaml`.
 */
export function resolveConfigPath(env: ConfigPathEnv = process.env): string {
  return (
    env.AGGREGATOR_CONFIG_PATH?.trim() || path.join(resolveConfigDir(env), 'aggregator.config.yaml')
  );
}

/**
 * Resolves the schema root directory path.
 *
 * Returns `SCHEMA_ROOT_DIR` when explicitly set; otherwise derives
 * `<resolveConfigDir(env)>/schemas`.
 *
 * @param env - Env-var bag; defaults to `process.env`.
 * @returns Absolute path to the `schemas/` directory.
 */
export function resolveSchemaRoot(env: ConfigPathEnv = process.env): string {
  return env.SCHEMA_ROOT_DIR?.trim() || path.join(resolveConfigDir(env), 'schemas');
}

/**
 * Returns the candidate paths of an aggregator schema file, most specific first.
 *
 * Callers use the first path that exists. A network or brand overrides the
 * shared schema by placing a complete copy at
 * `<network>[/<brand>]/schemas/aggregator/<file>`. Partial files are not
 * merged.
 *
 * Keep in sync with `apps/web/src/lib/config-paths.ts`, which does not
 * depend on this package.
 *
 * @param file - Bare schema file name, e.g. `registration.v1.json`.
 * @param env - Env-var bag; defaults to `process.env`.
 * @returns Root-relative paths, most specific first.
 */
export function aggregatorSchemaRelPaths(file: string, env: ConfigPathEnv = process.env): string[] {
  const net = env.AGGREGATOR_NETWORK?.trim() || 'blue_dot';
  const brand = env.AGGREGATOR_BRAND?.trim();
  const relPath = (...prefix: string[]): string =>
    path.join(...prefix, 'schemas', 'aggregator', file);
  return brand ? [relPath(net, brand), relPath(net), relPath()] : [relPath(net), relPath()];
}

/**
 * Resolves the active network and optional brand from env vars.
 *
 * The web app uses it to pick the consent content to show, and the api uses
 * it to pick the consent version to record, so both read the same file.
 * Defaults to `blue_dot`. A blank `AGGREGATOR_BRAND` counts as unset.
 *
 * @param env - Env-var bag; defaults to `process.env`.
 * @returns `{ network, brand? }`; `brand` is omitted when unset.
 */
export function resolveActiveNetwork(env: ConfigPathEnv = process.env): {
  network: string;
  brand?: string;
} {
  const network = env.AGGREGATOR_NETWORK?.trim() || 'blue_dot';
  const brandRaw = env.AGGREGATOR_BRAND?.trim();
  const result: { network: string; brand?: string } = { network };
  if (brandRaw) result.brand = brandRaw;
  return result;
}
