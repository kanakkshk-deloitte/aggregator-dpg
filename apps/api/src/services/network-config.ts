/**
 * Process-wide singleton for the resolved aggregator and signalstack network
 * config (`@aggregator-dpg/api`). Loaded once on first access from
 * `AGGREGATOR_CONFIG_PATH` (default `/app/config/aggregator.config.yaml`).
 *
 * Tests inject a pinned config via `_setNetworkConfig`.
 *
 * @module apps/api/services/network-config
 */

import path from 'node:path';
import { FileNetworkConfigLoader } from '@aggregator-dpg/network-config/loader';
import type { ResolvedNetworkConfig } from '@aggregator-dpg/network-config/interface';
import { resolveConfigPath } from '@aggregator-dpg/network-config/paths';
import { logger } from '../logger.js';
import {
  signalsUiUrls,
  unknownSignalsUiUrlDomains,
  enabledRegistrationModes,
  onboardingEnabledCapabilities,
  reservedOnboardingCapabilities,
  unknownOnboardingCapabilities,
} from '../config.js';

let cached: ResolvedNetworkConfig | null = null;
let inflight: Promise<ResolvedNetworkConfig> | null = null;

/**
 * Returns the resolved aggregator config. The first call reads the file and
 * fetches the signalstack network.json; later calls return the cached value.
 * Throws on any unrecoverable failure, so config errors surface at startup.
 */
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
    // Warn about `SIGNALS_UI_URLS` keys that match no declared domain (e.g. a typo).
    // Warn only; do not filter.
    for (const domain of unknownSignalsUiUrlDomains(signalsUiUrls, cached.domainIds)) {
      logger.warn(
        {
          operation: 'config.signalsUiUrls.domainCheck',
          status: 'unknown_domain',
          domain,
          known_domains: cached.domainIds,
        },
        `SIGNALS_UI_URLS: domain "${domain}" is not declared by this network — its Signals hand-off will never appear`,
      );
    }
    warnOnOnboardingAllowList(cached);
    logger.info(
      {
        operation: 'network-config.load',
        status: 'success',
        network_id: cached.network.id,
        domain_ids: cached.domainIds,
        brand: cached.aggregator.brand.short_name,
      },
      'aggregator network config resolved',
    );
    return cached;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/**
 * Checks the `AGGREGATOR_ONBOARDING_ENABLED` allow-list against the
 * registration modes this network declares, and logs problems:
 *
 * 1. A value naming no declared mode (e.g. `frm`): warn. Never filter or fail.
 * 2. A reserved value (`bulk`): its own message. It enables nothing.
 * 3. No declared mode left enabled: logged at error, because no link can be
 *    created. There is no fallback to "all enabled".
 *
 * @param cfg - The freshly resolved network config.
 */
function warnOnOnboardingAllowList(cfg: ResolvedNetworkConfig): void {
  const capabilities = onboardingEnabledCapabilities();
  if (capabilities === null) return;
  const declaredModes = Object.keys(cfg.aggregator.registration_modes ?? {});
  for (const capability of unknownOnboardingCapabilities(capabilities, declaredModes)) {
    logger.warn(
      {
        operation: 'config.onboardingEnabled.modeCheck',
        // `status` is the standard success/failure/skipped enum; the detail goes in `finding`.
        status: 'skipped',
        finding: 'unknown_capability',
        capability,
        declared_modes: declaredModes,
      },
      `AGGREGATOR_ONBOARDING_ENABLED: "${capability}" matches no registration mode declared by this network — it enables nothing`,
    );
  }
  for (const capability of reservedOnboardingCapabilities(capabilities)) {
    logger.warn(
      {
        operation: 'config.onboardingEnabled.modeCheck',
        status: 'skipped',
        finding: 'reserved_capability',
        capability,
        declared_modes: declaredModes,
      },
      `AGGREGATOR_ONBOARDING_ENABLED: "${capability}" is reserved for a future gate and currently gates nothing — it enables no registration mode. Listing it alone disables all onboarding.`,
    );
  }
  const enabledModes = enabledRegistrationModes(declaredModes);
  if (enabledModes.length === 0) {
    logger.error(
      {
        operation: 'config.onboardingEnabled.modeCheck',
        status: 'failure',
        // The configured value, not the enabled set (which is empty here).
        configured: capabilities,
        declared_modes: declaredModes,
      },
      `AGGREGATOR_ONBOARDING_ENABLED="${capabilities.join(',')}" enables none of this network's registration modes (${declaredModes.join(', ') || 'none declared'}) — no registration link can be created. Fix the value, or remove the variable entirely to enable all modes.`,
    );
  }
}

/** Test helper — inject a fake config; pass null to force re-load. */
export function _setNetworkConfig(cfg: ResolvedNetworkConfig | null): void {
  cached = cfg;
}
