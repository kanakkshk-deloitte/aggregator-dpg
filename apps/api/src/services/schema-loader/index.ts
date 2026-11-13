/**
 * Schema loader singleton for the API process (`@aggregator-dpg/api`).
 *
 * Resolution lives in `@aggregator-dpg/schema-loader/network`, shared with the
 * worker: participant ids come from network config, other ids from
 * `config/<network>/schemas/`. This module binds it to the API's config.
 */

import { NetworkSchemaLoader } from '@aggregator-dpg/schema-loader/network';
import { config } from '../../config.js';
import { getNetworkConfig } from '../network-config.js';

let instance: NetworkSchemaLoader | null = null;

/**
 * Returns the process-wide schema loader, creating it on first call.
 *
 * @returns The shared {@link NetworkSchemaLoader} bound to `SCHEMA_ROOT_DIR`.
 */
export function getSchemaLoader(): NetworkSchemaLoader {
  if (instance) return instance;
  instance = new NetworkSchemaLoader({
    rootDir: config.SCHEMA_ROOT_DIR,
    getNetworkConfig,
  });
  return instance;
}

/** Test helper; replaces the singleton with a fake loader. */
export function _setSchemaLoader(loader: NetworkSchemaLoader | null): void {
  instance = loader;
}
