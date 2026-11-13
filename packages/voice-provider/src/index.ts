/**
 * Public barrel and provider factory for the campaign voice channel.
 *
 * Re-exports the `./interface` contract and the `./egress` rate-limit gate.
 * `getVoiceProvider` is the only way to get a concrete
 * {@link VoiceProviderBase}; other packages never import `./raya.js`.
 *
 * @module @aggregator-dpg/voice-provider
 */

import { ConfigError } from '@aggregator-dpg/shared-primitives/errors';

import { RayaVoiceProvider } from './raya.js';
import type { VoiceProviderBase } from './interface.js';

/** Configuration accepted by {@link getVoiceProvider}. */
export interface VoiceProviderConfig {
  /** Which concrete provider to construct. Only `'raya'` is supported today. */
  provider: 'raya';
  /** Provider API base URL. */
  baseUrl: string;
  /** Provider API key. */
  apiKey: string;
  /**
   * Per-attempt request timeout in ms. Required; there is no default.
   */
  timeoutMs: number;
  /** Rate-limit gate awaited before every provider HTTP call (see `./egress.js`). */
  acquireSlot: () => Promise<void>;
  /** Optional max total attempts per HTTP call before giving up. Provider-defined default when omitted. */
  maxAttempts?: number;
  /** Optional `fetch` override, for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Constructs the configured voice provider.
 *
 * @param cfg - Provider selector plus connection/rate-limit config.
 * @returns A {@link VoiceProviderBase} instance for `cfg.provider`.
 * @throws {ConfigError} If `cfg.provider` names an unsupported provider.
 */
export function getVoiceProvider(cfg: VoiceProviderConfig): VoiceProviderBase {
  if (cfg.provider === 'raya') {
    return new RayaVoiceProvider({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      timeoutMs: cfg.timeoutMs,
      acquireSlot: cfg.acquireSlot,
      ...(cfg.maxAttempts !== undefined ? { maxAttempts: cfg.maxAttempts } : {}),
      ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}),
    });
  }
  const exhaustive: never = cfg.provider;
  throw new ConfigError(`unknown voice provider: ${String(exhaustive)}`);
}

export { VoiceProviderBase } from './interface.js';
export type { VoiceContact, VoiceDispatchInput, VoiceDispatchResult } from './interface.js';
export { acquireRayaSlot } from './egress.js';
export type { AcquireRayaSlotDeps } from './egress.js';
