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

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigError } from '@aggregator-dpg/shared-primitives/errors';
import { parseAggregatorConsentConfig, type AggregatorConsentConfig } from '../consent.schema.js';
import { deepMerge } from '../merge.js';
import { fileExists, findRepoRoot } from './repo-root.js';

/** Relative path suffix for consent files inside a config root. */
const CONSENT_SUFFIX = join('schemas', 'aggregator', 'consent.json');

/**
 * Placeholder for the support/grievance email in consent files. Replaced with
 * `CONSENT_SUPPORT_EMAIL` (or the default below) at load.
 */
const SUPPORT_EMAIL_PLACEHOLDER = '__SUPPORT_EMAIL__';
const DEFAULT_SUPPORT_EMAIL = 'hello@bluedotseconomy.org';

function resolveSupportEmail(): string {
  return process.env.CONSENT_SUPPORT_EMAIL || DEFAULT_SUPPORT_EMAIL;
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
    // Replace the placeholder before parsing so every field picks it up.
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
 * Loads and validates the consent configuration for the given network and
 * optional brand.
 *
 * Uses the network-level file, else the default. A brand-level file, if
 * present, is deep-merged on top.
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
  const repoRoot =
    configRoot ?? (await findRepoRoot(process.cwd(), 'CONSENT_CONFIG_ROOT_NOT_FOUND'));
  const configDir = join(repoRoot, 'config');

  const networkPath = join(configDir, network, CONSENT_SUFFIX);
  const defaultPath = join(configDir, CONSENT_SUFFIX);

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

  // The brand file may be partial, so validate only the merged result.
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
