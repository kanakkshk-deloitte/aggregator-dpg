/**
 * Filesystem loader for per-network (and per-brand) consent configuration.
 *
 * Resolves `consent.json` from the monorepo `config/` tree, applying
 * network-level and optional brand-level overrides via deep merge, then
 * validates the result with `parseAggregatorConsentConfig`.
 *
 * Resolution order (first file found wins for the base; brand file then
 * deep-merges on top):
 *   1. `<repoRoot>/config/<network>/<brand>/schemas/aggregator/consent.json`  (brand-specific)
 *   2. `<repoRoot>/config/<network>/schemas/aggregator/consent.json`           (network-specific)
 *   3. `<repoRoot>/config/schemas/aggregator/consent.json`                     (default fallback)
 *
 * @module @aggregator-dpg/config-loader/fs
 */

import { readFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { ConfigError } from '@aggregator-dpg/shared-primitives/errors';
import { parseAggregatorConsentConfig, type AggregatorConsentConfig } from '../consent.schema.js';
import { deepMerge } from '../merge.js';

/** Relative path suffix for consent files inside a config root. */
const CONSENT_SUFFIX = join('schemas', 'aggregator', 'consent.json');

/**
 * Placeholder canonical consent files ship in place of the literal
 * support/grievance email, so the address is configurable without editing
 * consent content. Rendered to `CONSENT_SUPPORT_EMAIL` (default below) at load;
 * deployed instances additionally have it substituted upstream at ConfigMap
 * render, so this keeps local/direct reads showing a real address.
 */
const SUPPORT_EMAIL_PLACEHOLDER = '__SUPPORT_EMAIL__';
const DEFAULT_SUPPORT_EMAIL = 'hello@bluedotseconomy.org';

function resolveSupportEmail(): string {
  return process.env.CONSENT_SUPPORT_EMAIL || DEFAULT_SUPPORT_EMAIL;
}

/**
 * Returns true if the file at `filePath` exists and is readable.
 *
 * @param filePath - Absolute path to test.
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads and parses a JSON file from disk.
 *
 * @param filePath - Absolute path to the JSON file.
 * @returns The parsed object.
 * @throws {ConfigError} If the file cannot be read or is not valid JSON.
 */
async function readJson(filePath: string): Promise<unknown> {
  try {
    const text = await readFile(filePath, 'utf8');
    // Render the support-email placeholder before parsing so every content
    // field that references it picks up the configured address.
    const rendered = text.split(SUPPORT_EMAIL_PLACEHOLDER).join(resolveSupportEmail());
    return JSON.parse(rendered) as unknown;
  } catch (err) {
    throw new ConfigError(`Failed to read or parse consent config at ${filePath}`, {
      code: 'CONSENT_CONFIG_READ_ERROR',
      details: { filePath, cause: String(err) },
    });
  }
}

/**
 * Determines the monorepo root by searching upward from `startDir` for a
 * directory that contains `config/schemas/aggregator/`.
 *
 * Tries three candidate paths relative to `startDir`:
 *   - `../../config`  (typical when cwd is apps/web or apps/api)
 *   - `../config`
 *   - `config`
 *
 * @param startDir - Directory to start searching from (usually process.cwd()).
 * @returns Absolute path to the monorepo root (the directory that owns `config/`).
 * @throws {ConfigError} If no suitable root is found.
 */
async function findRepoRoot(startDir: string): Promise<string> {
  const candidates = [resolve(startDir, '../..'), resolve(startDir, '..'), resolve(startDir)];

  for (const candidate of candidates) {
    const probe = join(candidate, 'config', 'schemas', 'aggregator');
    if (await fileExists(probe)) {
      return candidate;
    }
  }

  throw new ConfigError(
    `Cannot locate monorepo root from "${startDir}": no config/schemas/aggregator/ directory found in [${candidates.join(', ')}]`,
    { code: 'CONSENT_CONFIG_ROOT_NOT_FOUND', details: { startDir } },
  );
}

/**
 * Loads and validates the consent configuration for the given network and
 * optional brand.
 *
 * Resolution order:
 *   1. Looks for a network-level file, falling back to the default.
 *   2. If `brand` is provided and a brand-level file exists, deep-merges it
 *      on top of the network/default file.
 *
 * Throws `ConfigError` if no file can be found or if validation fails.
 *
 * @param network - Network identifier (e.g. `"blue_dot"`, `"orange_dot"`).
 * @param brand - Optional sub-brand identifier (e.g. `"onetac"`).
 * @param configRoot - Optional absolute path to the monorepo root. When
 *   omitted the root is discovered automatically from `process.cwd()`.
 * @returns The validated AggregatorConsentConfig.
 * @throws {ConfigError} If no consent file is found or the content is invalid.
 */
export async function loadConsentConfig(
  network: string,
  brand?: string,
  configRoot?: string,
): Promise<AggregatorConsentConfig> {
  const repoRoot = configRoot ?? (await findRepoRoot(process.cwd()));
  const configDir = join(repoRoot, 'config');

  // Build base candidate paths: network-specific → default fallback.
  const networkPath = join(configDir, network, CONSENT_SUFFIX);
  const defaultPath = join(configDir, CONSENT_SUFFIX);

  // Find the first existing base file.
  let basePath: string | undefined;
  for (const candidate of [networkPath, defaultPath]) {
    if (await fileExists(candidate)) {
      basePath = candidate;
      break;
    }
  }

  if (basePath === undefined) {
    throw new ConfigError(
      `No consent config found for network "${network}". Tried: ${[networkPath, defaultPath].join(', ')}`,
      {
        code: 'CONSENT_CONFIG_NOT_FOUND',
        details: { network, tried: [networkPath, defaultPath] },
      },
    );
  }

  const baseRaw = await readJson(basePath);
  let config = parseAggregatorConsentConfig(baseRaw);

  // If a brand is specified, look for a brand-level override and merge it.
  // The brand file is treated as a *partial* override (the docstring for
  // mergeConsentConfigs states that partial brand overrides are supported).
  // Validating the brand file as a full config before the merge would reject
  // single-audience brand files; instead we deep-merge the raw unknown value
  // onto the validated base and validate the merged result once.
  if (brand !== undefined) {
    const brandPath = join(configDir, network, brand, CONSENT_SUFFIX);
    if (await fileExists(brandPath)) {
      const brandRaw = await readJson(brandPath);
      const merged = deepMerge(
        JSON.parse(JSON.stringify(config)) as Record<string, unknown>,
        JSON.parse(JSON.stringify(brandRaw)) as Record<string, unknown>,
      );
      config = parseAggregatorConsentConfig(merged);
    }
  }

  return config;
}
