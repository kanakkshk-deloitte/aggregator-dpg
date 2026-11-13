/**
 * Schema loader singleton for the worker app.
 *
 * Wraps `@aggregator-dpg/schema-loader/network` with the worker's config and
 * network config.
 */

import { NetworkSchemaLoader } from '@aggregator-dpg/schema-loader/network';
import { config } from '../config.js';
import { getNetworkConfig } from './network-config.js';

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
