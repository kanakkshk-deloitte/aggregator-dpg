/**
 * Filesystem loader for the Signals participant realm roles.
 *
 * One Keycloak realm serves both DPGs, so a token without `aggregator_id` may
 * still be a valid Signals identity. The login screen uses these roles to show
 * which account the visitor is signed in as.
 *
 * Read from `aggregator.signals.realm_roles` in the network's
 * `aggregator.config.yaml`.
 *
 * Resolution order (first existing file with roles wins, no merging):
 *   1. `<repoRoot>/config/<network>/<brand>/aggregator.config.yaml`
 *   2. `<repoRoot>/config/<network>/aggregator.config.yaml`
 *
 * @module @aggregator-dpg/config-loader/fs
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { ConfigError } from '@aggregator-dpg/shared-primitives/errors';
import { fileExists, findRepoRoot } from './repo-root.js';

/** Config file holding the per-network aggregator settings. */
const CONFIG_FILE = 'aggregator.config.yaml';

/**
 * Reads the role list out of a parsed `aggregator.config.yaml`.
 *
 * Accepts a YAML sequence or a comma-separated string, matching the
 * `SIGNALS_REALM_ROLES` env format. An absent key means unconfigured.
 *
 * @param doc - Parsed YAML document, whatever shape it turned out to be.
 * @returns Trimmed, non-empty role names; empty when the key is absent.
 */
function extractRoles(doc: unknown): string[] {
  if (doc === null || typeof doc !== 'object') return [];
  const aggregator = (doc as Record<string, unknown>)['aggregator'];
  if (aggregator === null || typeof aggregator !== 'object') return [];
  const signals = (aggregator as Record<string, unknown>)['signals'];
  if (signals === null || typeof signals !== 'object') return [];
  const roles = (signals as Record<string, unknown>)['realm_roles'];

  if (Array.isArray(roles)) {
    return roles.map((r) => String(r).trim()).filter((r) => r.length > 0);
  }
  if (typeof roles === 'string') {
    return roles
      .split(',')
      .map((r) => r.trim())
      .filter((r) => r.length > 0);
  }
  return [];
}

/**
 * Loads the Signals participant realm roles for a network/brand.
 *
 * Returns an empty array when the key is absent. Throws only when a config file
 * exists but cannot be read or parsed. Callers should log the error and fall
 * back to generic text, not fail the page.
 *
 * @param network - Network identifier (e.g. `"blue_dot"`, `"purple_dot"`).
 * @param brand - Optional brand sub-folder (e.g. `"upsdm"`).
 * @param configRoot - Optional absolute path to the directory owning `config/`.
 *   Discovered from `process.cwd()` when omitted.
 * @returns The configured role names, or an empty array when unconfigured.
 * @throws {ConfigError} If the monorepo root cannot be located, or a config
 *   file exists but cannot be read or parsed as YAML.
 */
export async function loadSignalsRealmRoles(
  network: string,
  brand?: string,
  configRoot?: string,
): Promise<string[]> {
  const repoRoot =
    configRoot ?? (await findRepoRoot(process.cwd(), 'SIGNALS_ROLES_CONFIG_ROOT_NOT_FOUND'));
  const configDir = join(repoRoot, 'config');

  const candidates = brand
    ? [join(configDir, network, brand, CONFIG_FILE), join(configDir, network, CONFIG_FILE)]
    : [join(configDir, network, CONFIG_FILE)];

  for (const candidate of candidates) {
    if (!(await fileExists(candidate))) continue;
    let doc: unknown;
    try {
      doc = parseYaml(await readFile(candidate, 'utf8'));
    } catch (err) {
      throw new ConfigError(`Failed to read or parse ${CONFIG_FILE} at ${candidate}`, {
        code: 'SIGNALS_ROLES_CONFIG_READ_ERROR',
        details: { filePath: candidate, network, brand, cause: String(err) },
      });
    }
    const roles = extractRoles(doc);
    if (roles.length > 0) return roles;
  }

  return [];
}
