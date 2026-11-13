/**
 * Resolved network config singleton for the worker app.
 *
 * Loaded once on first use from `AGGREGATOR_CONFIG_PATH`. The bulk row
 * processor uses it for identity fields, item_type and the array delimiter.
 *
 * @module apps/worker/services/network-config
 */

import path from 'node:path';
import { FileNetworkConfigLoader } from '@aggregator-dpg/network-config/loader';
import type { ResolvedNetworkConfig } from '@aggregator-dpg/network-config/interface';
import { resolveConfigPath } from '@aggregator-dpg/network-config/paths';
import { logger } from '../logger.js';

let cached: ResolvedNetworkConfig | null = null;
let inflight: Promise<ResolvedNetworkConfig> | null = null;

export async function getNetworkConfig(): Promise<ResolvedNetworkConfig> {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    const configPath = resolveConfigPath();
    const cacheDir =
      process.env.NETWORK_CONFIG_CACHE_DIR ?? path.join(path.dirname(configPath), '.cache');
    const loader = new FileNetworkConfigLoader({ configPath, cacheDir });
    const result = await loader.load();
    if (!result.success) {
      const message =
        'error' in result && typeof result.error === 'object' && result.error
          ? ((result.error as { message?: string }).message ?? 'unknown error')
          : 'unknown error';
      logger.error({
        operation: 'network-config.load',
        status: 'failure',
        config_path: configPath,
        error: message,
      });
      throw new Error(`network-config load failed: ${message}`);
    }
    cached = result.value;
    logger.info(
      {
        operation: 'network-config.load',
        status: 'success',
        network_id: cached.network.id,
        domain_ids: cached.domainIds,
      },
      'worker network config resolved',
    );
    return cached;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** Test helper. */
export function _setNetworkConfig(cfg: ResolvedNetworkConfig | null): void {
  cached = cfg;
}
