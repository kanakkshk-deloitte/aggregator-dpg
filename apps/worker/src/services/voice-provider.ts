/**
 * Voice provider factory for the worker app.
 *
 * Builds a singleton provider from `config.RAYA_*` with the fail-closed Raya
 * rate gate on the shared Redis connection. A missing `RAYA_API_KEY` throws on
 * first use, not at boot.
 *
 * @module @aggregator-dpg/worker
 */

import { ConfigError } from '@aggregator-dpg/shared-primitives/errors';
import {
  acquireRayaSlot,
  getVoiceProvider as buildVoiceProvider,
} from '@aggregator-dpg/voice-provider';
import type { VoiceProviderBase } from '@aggregator-dpg/voice-provider/interface';
import { config } from '../config.js';
import { getRedis } from './redis.js';

let provider: VoiceProviderBase | undefined;

/**
 * Returns the singleton voice provider, constructing it on first use.
 *
 * @returns The configured {@link VoiceProviderBase} instance.
 * @throws {ConfigError} If `RAYA_API_KEY` is unset.
 */
export function getVoiceProvider(): VoiceProviderBase {
  if (provider) return provider;
  const apiKey = config.RAYA_API_KEY;
  if (!apiKey) {
    throw new ConfigError('RAYA_API_KEY must be set to run a voice campaign job', {
      code: 'RAYA_API_KEY_MISSING',
    });
  }
  provider = buildVoiceProvider({
    provider: config.CAMPAIGN_VOICE_PROVIDER,
    baseUrl: config.RAYA_BASE_URL,
    apiKey,
    timeoutMs: config.RAYA_TIMEOUT_MS,
    acquireSlot: () =>
      acquireRayaSlot({
        redis: getRedis(),
        windowSeconds: config.RAYA_EGRESS_WINDOW_SECONDS,
        max: config.RAYA_EGRESS_MAX,
      }),
  });
  return provider;
}

/** Replaces the provider, for tests. Pass `undefined` to rebuild on next use. */
export function _setVoiceProvider(p: VoiceProviderBase | undefined): void {
  provider = p;
}
