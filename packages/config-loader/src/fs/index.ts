/**
 * Filesystem implementation of ConfigServiceBase.
 *
 * Discovers per-package schemas, merges defaults and config/env/<env>.yaml
 * overrides, and exposes typed get/require accessors. Throws ConfigError on any
 * load failure.
 *
 * Import via the ./fs subpath — never import from src/fs directly.
 *
 * @module @aggregator-dpg/config-loader/fs
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { ConfigError } from '@aggregator-dpg/shared-primitives/errors';
import { sliceFromStore, getFromStore, requireFromStore } from '../store-access.js';
import type { ConfigChangeCallback, Env, Unsubscribe } from '../interface.js';
import { ConfigServiceBase } from '../interface.js';
import { discoverPackages, type RegisteredPackage } from '../discovery.js';
import { deepMerge } from '../merge.js';
import { interpolateConfig } from '../interpolate.js';
import { validateConfig } from '../validate.js';
import { startWatcher } from './watcher.js';
export { resolveEnv } from '../env.js';
export { loadConsentConfig } from './consent-loader.js';
export { loadSignalsRealmRoles } from './signals-roles-loader.js';

/**
 * Loads YAML from disk. Returns an empty object if the file does not exist.
 *
 * @throws {ConfigError} If the file exists but cannot be parsed.
 */
function loadYaml(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  try {
    const raw = readFileSync(filePath, 'utf8');
    // An empty file is an empty override. js-yaml throws on empty input.
    if (raw.trim() === '') return {};
    const parsed = parseYaml(raw);
    if (parsed === null || parsed === undefined) return {};
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ConfigError(
        `Config file must be a YAML mapping, got ${typeof parsed}: ${filePath}`,
        { code: 'CONFIG_PARSE_ERROR' },
      );
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(`Failed to parse config file: ${filePath}`, {
      code: 'CONFIG_PARSE_ERROR',
      details: { cause: String(err) },
    });
  }
}

/**
 * Filesystem-backed ConfigService implementation.
 *
 * Reads config/env/<env>.yaml and exposes typed get/require accessors.
 * Call load() once at application boot before accessing any config values.
 */
export class FsConfigService extends ConfigServiceBase {
  private store: Record<string, unknown> = {};
  private currentEnv: Env | undefined;
  private readonly listeners = new Set<ConfigChangeCallback>();
  private readonly repoRoot: string;
  /** Populated after load() — keyed by configKey. */
  private registry = new Map<string, RegisteredPackage>();

  /**
   * @param repoRoot - Absolute path to the monorepo root. Defaults to process.cwd().
   */
  constructor(repoRoot: string = process.cwd()) {
    super();
    this.repoRoot = repoRoot;
  }

  /**
   * Loads config for the given environment.
   *
   * Discovers per-package configSchema + configKey, then merges
   * config/env/<env>.yaml overrides into the store.
   *
   * @param env - The deployment environment.
   * @throws {ConfigError} If schema discovery fails or any YAML file cannot be parsed.
   */
  async load(env: Env): Promise<void> {
    const packagesDir = join(this.repoRoot, 'packages');
    this.registry = await discoverPackages(packagesDir);

    // Per-package defaults: TypeScript defaults, then config.defaults.yaml on top.
    const merged: Record<string, unknown> = {};
    for (const [key, pkg] of this.registry) {
      const defaults: Record<string, unknown> = {};
      if (pkg.configDefaults !== undefined) {
        deepMerge(defaults, pkg.configDefaults);
      }

      const defaultsFilePath = join(pkg.packageDir, 'config.defaults.yaml');
      const yamlDefaults = loadYaml(defaultsFilePath);
      const yamlSlice = Object.hasOwn(yamlDefaults, key) ? yamlDefaults[key] : yamlDefaults;
      if (yamlSlice !== undefined) {
        if (yamlSlice === null || typeof yamlSlice !== 'object' || Array.isArray(yamlSlice)) {
          throw new ConfigError(
            `Default config for "${key}" must be a YAML mapping: ${defaultsFilePath}`,
            {
              code: 'CONFIG_PARSE_ERROR',
              details: { configKey: key, filePath: defaultsFilePath },
            },
          );
        }
        deepMerge(defaults, yamlSlice as Record<string, unknown>);
      }
      merged[key] = defaults;
    }

    // Env YAML overrides the defaults.
    const envFilePath = join(this.repoRoot, 'config', 'env', `${env}.yaml`);
    deepMerge(merged, loadYaml(envFilePath));

    const interpolated = interpolateConfig(merged);

    // The store holds the Zod-coerced output.
    this.store = validateConfig(interpolated, this.registry);
    this.currentEnv = env;
  }

  /**
   * Returns the discovered package registry.
   * Available after load() has been called.
   */
  getRegistry(): ReadonlyMap<string, RegisteredPackage> {
    return this.registry;
  }

  /**
   * Returns the validated, typed config slice for the given package configKey.
   *
   * @param key - The package's configKey (e.g. "signalStack").
   * @throws {ConfigError} With code CONFIG_KEY_MISSING if the key is absent.
   */
  slice<T>(key: string): T {
    return sliceFromStore<T>(this.store, key);
  }

  /**
   * Returns the value at the given dotted path, or undefined if absent.
   *
   * @param path - Dotted key path, e.g. "signalStack.baseUrl".
   */
  get<T = unknown>(path: string): T | undefined {
    return getFromStore<T>(this.store, path);
  }

  /**
   * Returns the value at the given dotted path, throwing if absent.
   *
   * @param path - Dotted key path.
   * @throws {ConfigError} If the path does not exist or the value is undefined.
   */
  require<T = unknown>(path: string): T {
    return requireFromStore<T>(this.store, path);
  }

  /**
   * Reloads config from disk and notifies all onChange listeners on success.
   * Previous config remains active if reload fails.
   *
   * @throws {ConfigError} If the reload fails.
   */
  async reload(): Promise<void> {
    if (this.currentEnv === undefined) {
      throw new ConfigError('Cannot reload before initial load() call', {
        code: 'CONFIG_NOT_LOADED',
      });
    }
    const previous = this.store;
    try {
      await this.load(this.currentEnv);
    } catch (err) {
      this.store = previous;
      throw err;
    }
    for (const cb of this.listeners) {
      cb();
    }
  }

  /**
   * Registers a callback invoked after each successful reload.
   *
   * @param cb - Called after config is refreshed.
   * @returns Unsubscribe function to remove the listener.
   */
  onChange(cb: ConfigChangeCallback): Unsubscribe {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /**
   * Starts watching `config/` for file changes, reloading after a 300 ms debounce.
   *
   * Skipped (returns no-op) when:
   * - The current environment is `production` — a warning is logged.
   * - `CONFIG_WATCH` env var is not exactly `"1"`.
   *
   * Call after `load()`. Stop the watcher by calling the returned unsubscribe
   * function before process shutdown.
   *
   * @returns Unsubscribe function that stops watching.
   */
  watch(): Unsubscribe {
    if (this.currentEnv === 'production') {
      console.warn(
        '[config-loader] CONFIG_WATCH is ignored in production — restart the process to apply config changes',
      );
      return () => {};
    }
    if (process.env['CONFIG_WATCH'] !== '1') {
      return () => {};
    }
    const configDir = join(this.repoRoot, 'config');
    console.info(`[config-loader] Watching ${configDir} for changes (debounce 300 ms)`);
    return startWatcher(configDir, 300, () => this.reload());
  }
}
