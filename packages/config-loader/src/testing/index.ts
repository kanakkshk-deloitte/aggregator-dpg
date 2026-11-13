/**
 * In-memory ConfigService fake for use in unit tests.
 *
 * Accepts a plain object at construction time — no filesystem access.
 * Use this instead of mocking FsConfigService in tests.
 *
 * Import via the ./testing subpath — never import from src/testing directly.
 *
 * @module @aggregator-dpg/config-loader/testing
 */

import { sliceFromStore, getFromStore, requireFromStore } from '../store-access.js';
import type { ConfigChangeCallback, Env, Unsubscribe } from '../interface.js';
import { ConfigServiceBase } from '../interface.js';
export type { ConfigSlice } from '../interface.js';

/**
 * In-memory ConfigService for tests.
 *
 * Pass a plain config object to the constructor or seed() to pre-populate
 * state without touching the filesystem.
 *
 * @example
 * const config = new ConfigServiceFake({ signalStack: { baseUrl: 'http://localhost' } });
 * await config.load('test');
 * config.require<string>('signalStack.baseUrl'); // 'http://localhost'
 */
export class ConfigServiceFake extends ConfigServiceBase {
  private store: Record<string, unknown>;
  private readonly listeners = new Set<ConfigChangeCallback>();

  /**
   * @param initial - Initial config tree. Defaults to an empty object.
   */
  constructor(initial: Record<string, unknown> = {}) {
    super();
    this.store = { ...initial };
  }

  /**
   * No-op load — the in-memory store is already populated.
   * Accepts any env value without error.
   */
  async load(_env: Env): Promise<void> {
    // no-op: store set at construction or via seed()
  }

  /**
   * Returns the typed config slice for the given configKey.
   *
   * @param key - The package's configKey.
   * @throws {ConfigError} With code CONFIG_KEY_MISSING if the key is absent.
   */
  slice<T>(key: string): T {
    return sliceFromStore<T>(this.store, key);
  }

  /**
   * Returns the value at the given dotted path, or undefined if absent.
   *
   * @param path - Dotted key path.
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
   * Notifies all onChange listeners. The store is unchanged.
   */
  async reload(): Promise<void> {
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
   * No-op. The fake has no files to watch.
   *
   * @returns No-op unsubscribe function.
   */
  watch(): Unsubscribe {
    return () => {};
  }

  /**
   * Replaces the in-memory store with the given config tree.
   *
   * Use in test setup to change config between test cases.
   *
   * @param config - New config tree to install.
   */
  seed(config: Record<string, unknown>): void {
    this.store = { ...config };
  }
}
