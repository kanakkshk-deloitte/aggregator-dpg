/**
 * Public interface contract for the campaign voice channel.
 *
 * The campaign worker's voice handler calls providers through
 * `VoiceProviderBase`. Concrete providers such as Raya extend it. Other
 * packages import only from this subpath.
 *
 * @module @aggregator-dpg/voice-provider/interface
 */

import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';

/**
 * A single call-recipient row within a voice dispatch batch.
 */
export interface VoiceContact {
  /** Caller-assigned identifier correlating this contact back to a `campaign_job_item`. */
  ref: string;
  /** Recipient display name, passed through to the provider as a call variable. */
  name: string;
  /** Recipient phone number in the format the provider expects. */
  phone: string;
  /** Optional country calling code (e.g. `+91`), when the provider requires it separately from `phone`. */
  countryCode?: string;
  /** Template variables interpolated into the voice script (e.g. role, employer). */
  variables: Record<string, string>;
}

/**
 * Input to {@link VoiceProviderBase.dispatch} — one outbound-call batch.
 */
export interface VoiceDispatchInput {
  /** Provider-side agent/flow identifier to run the batch against. */
  agentRef: string;
  /** Human-readable batch name surfaced in the provider's own dashboard. */
  batchName: string;
  /** Recipients to include in the batch. */
  contacts: VoiceContact[];
  /** Provider-specific start options (e.g. `max_concurrent_calls`, `selected_statuses`). */
  startOptions: Record<string, unknown>;
  /**
   * Set when this `dispatch()` is a BullMQ retry, never on a first attempt.
   * A provider may then reuse an existing batch named `batchName` instead of
   * creating a duplicate. Omitted or `false` means do not reuse.
   */
  reuseExisting?: boolean;
}

/**
 * Type-only brand for a provider response reduced to a PII-free whitelist.
 *
 * A raw upstream payload does not type-check as this type, so it cannot be
 * stored in `VoiceDispatchResult.providerResponse` by accident.
 */
declare const CURATED_PROVIDER_RESPONSE: unique symbol;
export type CuratedProviderResponse<T = Record<string, unknown>> = T & {
  readonly [CURATED_PROVIDER_RESPONSE]: true;
};

/**
 * Marks an already-curated (whitelist-only) payload as safe to persist.
 *
 * Call it only after every PII field is removed, never on a raw payload.
 *
 * @param value - Already-curated (whitelist-only) data.
 * @returns The same value, tagged at the type level as curated.
 */
export function brandCuratedProviderResponse<T extends Record<string, unknown>>(
  value: T,
): CuratedProviderResponse<T> {
  return value as CuratedProviderResponse<T>;
}

/**
 * Result of a successful (or partially successful) {@link VoiceProviderBase.dispatch} call.
 */
export interface VoiceDispatchResult {
  /** Provider-assigned identifier for the created batch. */
  providerBatchRef: string;
  /** `ref`s of contacts the provider accepted into the batch. */
  accepted: string[];
  /** `ref` + reason for contacts the provider rejected at create time. */
  rejected: { ref: string; error: string }[];
  /**
   * Curated provider responses for the create and start calls, kept for
   * audit and debugging. Must not contain PII.
   */
  providerResponse: {
    create: CuratedProviderResponse;
    start: CuratedProviderResponse | null;
  };
}

/**
 * Abstract base class for a voice-calling provider.
 *
 * Concrete implementations must extend this class with the same signatures.
 * Only `dispatch` (create + start) is declared; there are no stop or update
 * actions.
 */
export abstract class VoiceProviderBase {
  /**
   * Creates and starts an outbound-call batch with the given contacts.
   *
   * @param input - The batch definition (agent, name, contacts, start options).
   * @returns The batch reference and per-contact outcome, or Err if no batch was created.
   */
  abstract dispatch(input: VoiceDispatchInput): Promise<Result<VoiceDispatchResult, BaseError>>;
}
