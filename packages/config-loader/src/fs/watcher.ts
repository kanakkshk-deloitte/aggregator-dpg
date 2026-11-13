/**
 * Filesystem watcher for config hot-reload.
 *
 * Watches a directory recursively and calls the reload callback after a
 * debounce, so a burst of changes triggers one reload.
 *
 * @module @aggregator-dpg/config-loader/fs/watcher (internal)
 */

import { watch } from 'node:fs';
import type { Unsubscribe } from '../interface.js';

/**
 * Starts a recursive directory watcher with debounce.
 *
 * @param configDir - Absolute path to the directory to watch.
 * @param debounceMs - Milliseconds to wait after the last event before reloading.
 * @param onReload - Async callback invoked after the debounce settles.
 * @returns Unsubscribe function that stops the watcher and cancels any pending reload.
 */
export function startWatcher(
  configDir: string,
  debounceMs: number,
  onReload: () => Promise<void>,
): Unsubscribe {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const watcher = watch(configDir, { recursive: true }, () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      void onReload().catch((err: unknown) => {
        console.error('[config-loader] Config reload failed; keeping previous config', err);
      });
    }, debounceMs);
  });

  return () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    watcher.close();
  };
}
