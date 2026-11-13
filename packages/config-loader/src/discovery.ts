/**
 * Per-package config schema discovery.
 *
 * Walks packages/ looking for config.schema.ts (dev/tsx) or dist/config.schema.js
 * (production). Imports each, collects configKey + configSchema, and validates
 * that no two packages share the same configKey.
 *
 * Called by FsConfigService.load() before merging defaults and env overrides.
 *
 * @module @aggregator-dpg/config-loader/discovery
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { z } from 'zod';
import { ConfigError } from '@aggregator-dpg/shared-primitives/errors';

/** Shape every config.schema module must export. */
export interface ConfigSchemaModule {
  configKey: unknown;
  configSchema: unknown;
  /** Optional baseline values merged into the config tree before env overrides. */
  configDefaults?: unknown;
}

/** One registered package entry after discovery. */
export interface RegisteredPackage {
  /** Package name from package.json (e.g. "@aggregator-dpg/signal-stack"). */
  packageName: string;
  /** Absolute path to the package directory. */
  packageDir: string;
  /** Top-level key in the merged config tree (e.g. "signalStack"). */
  configKey: string;
  /** Zod schema validating this package's config slice. */
  configSchema: z.ZodTypeAny;
  /**
   * Baseline config values for this package's slice.
   * Merged into the tree before env YAML overrides are applied.
   */
  configDefaults?: Record<string, unknown>;
}

/**
 * Attempts to import a package's config schema module.
 *
 * Tries dist/config.schema.js first (production / after build),
 * then src/config.schema.ts (dev under tsx).
 * Returns null if neither file exists.
 *
 * @param packageDir - Absolute path to the package directory.
 */
async function importConfigModule(packageDir: string): Promise<ConfigSchemaModule | null> {
  const distPath = join(packageDir, 'dist', 'config.schema.js');
  const srcPath = join(packageDir, 'src', 'config.schema.ts');

  if (existsSync(distPath)) {
    return import(pathToFileURL(distPath).href) as Promise<ConfigSchemaModule>;
  }
  if (existsSync(srcPath)) {
    return import(pathToFileURL(srcPath).href) as Promise<ConfigSchemaModule>;
  }
  return null;
}

/**
 * Reads the package name from a package.json file.
 * Falls back to the directory name if parsing fails.
 */
function readPackageName(packageJsonPath: string, fallback: string): string {
  try {
    const raw = readFileSync(packageJsonPath, 'utf8');
    const parsed = JSON.parse(raw) as { name?: string };
    return parsed.name ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Discovers all packages with a config.schema module under packagesDir.
 *
 * @param packagesDir - Absolute path to the packages/ directory.
 * @returns Map from configKey to RegisteredPackage.
 * @throws {ConfigError} If any package is missing configKey, configSchema, or if
 *   two packages declare the same configKey.
 */
export async function discoverPackages(
  packagesDir: string,
): Promise<Map<string, RegisteredPackage>> {
  const registry = new Map<string, RegisteredPackage>();

  let entries: string[];
  try {
    entries = readdirSync(packagesDir);
  } catch {
    return registry;
  }

  for (const entry of entries) {
    const packageDir = join(packagesDir, entry);

    try {
      if (!statSync(packageDir).isDirectory()) continue;
    } catch {
      continue;
    }

    const packageJsonPath = join(packageDir, 'package.json');
    if (!existsSync(packageJsonPath)) continue;

    const mod = await importConfigModule(packageDir);
    if (mod === null) continue;

    const packageName = readPackageName(packageJsonPath, entry);

    if (!mod.configKey || typeof mod.configKey !== 'string') {
      throw new ConfigError(
        `Package "${packageName}" exports config.schema but is missing a non-empty configKey string export.`,
        { code: 'CONFIG_MISSING_KEY', details: { package: packageName } },
      );
    }

    if (!mod.configSchema) {
      throw new ConfigError(
        `Package "${packageName}" exports config.schema but is missing configSchema export.`,
        { code: 'CONFIG_MISSING_SCHEMA', details: { package: packageName } },
      );
    }

    if (registry.has(mod.configKey)) {
      const existing = registry.get(mod.configKey)!;
      throw new ConfigError(
        `Duplicate configKey "${mod.configKey}" declared by "${existing.packageName}" and "${packageName}". ` +
          `Each package must declare a unique configKey.`,
        {
          code: 'CONFIG_DUPLICATE_KEY',
          details: { configKey: mod.configKey, packages: [existing.packageName, packageName] },
        },
      );
    }

    const configDefaults =
      mod.configDefaults !== undefined &&
      mod.configDefaults !== null &&
      typeof mod.configDefaults === 'object' &&
      !Array.isArray(mod.configDefaults)
        ? (mod.configDefaults as Record<string, unknown>)
        : undefined;

    registry.set(mod.configKey, {
      packageName,
      packageDir,
      configKey: mod.configKey,
      configSchema: mod.configSchema as z.ZodTypeAny,
      ...(configDefaults !== undefined && { configDefaults }),
    });
  }

  return registry;
}
