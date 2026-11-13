/**
 * In-memory fake for {@link VoiceProviderBase}, used instead of a real Raya
 * connection.
 *
 * Records every {@link dispatch} call. {@link InMemoryVoiceProvider.setReject}
 * makes a contact fail, to test the partial-batch path.
 *
 * `dispatch()` builds Raya's raw response shape, including PII fields, then
 * reduces it to the same whitelist `raya.ts` uses. The whitelist is copied
 * because this module must not import `raya.ts`. Keep the two lists in sync.
 *
 * @module @aggregator-dpg/voice-provider/testing
 */

import { ok } from '@aggregator-dpg/shared-primitives/result';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';

import {
  VoiceProviderBase,
  brandCuratedProviderResponse,
  type VoiceDispatchInput,
  type VoiceDispatchResult,
} from './interface.js';

/** Copy of `raya.ts`'s `CREATE_RESPONSE_PERSIST_KEYS`. */
const CREATE_RESPONSE_PERSIST_KEYS = [
  'status',
  'message',
  'totalRows',
  'validRows',
  'invalidRows',
  'batchId',
  'contactsInserted',
] as const;

/** Copy of `raya.ts`'s `START_RESPONSE_PERSIST_KEYS`. */
const START_RESPONSE_PERSIST_KEYS = [
  'id',
  'status',
  'total_contacts',
  'completed_contacts',
  'unanswered_contacts',
  'schedule',
  'max_retries',
  'concurrency',
  'retry_after_hrs',
] as const;

/** Returns only the whitelisted keys present on `payload`. */
function pickWhitelisted(
  payload: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (payload[key] !== undefined) out[key] = payload[key];
  }
  return out;
}

/**
 * In-memory {@link VoiceProviderBase} implementation. Accepts every contact
 * unless {@link setReject} was called for it.
 */
export class InMemoryVoiceProvider extends VoiceProviderBase {
  /** Every `dispatch()` call this instance has received, in call order. */
  readonly dispatches: VoiceDispatchInput[] = [];

  /**
   * Pending rejections keyed by contact `ref`. Each is used once.
   */
  private readonly pendingRejections: Map<string, string> = new Map();

  private nextBatchSeq = 1;

  /**
   * Arms a rejection for the next `dispatch()` call containing a contact
   * with this `ref`. The rejection is consumed on use.
   *
   * @param ref - The contact `ref` to reject.
   * @param error - The rejection reason surfaced on `VoiceDispatchResult.rejected`.
   */
  setReject(ref: string, error: string): void {
    this.pendingRejections.set(ref, error);
  }

  override async dispatch(
    input: VoiceDispatchInput,
  ): Promise<Result<VoiceDispatchResult, BaseError>> {
    this.dispatches.push(input);

    const accepted: string[] = [];
    const rejected: { ref: string; error: string }[] = [];
    // Matches Raya's `errors[]` shape. `value` is the phone (PII) and is removed below.
    const rawErrors: Array<{ row: number; field: string; value: string; message: string }> = [];
    input.contacts.forEach((contact, index) => {
      const rejection = this.pendingRejections.get(contact.ref);
      if (rejection !== undefined) {
        this.pendingRejections.delete(contact.ref);
        rejected.push({ ref: contact.ref, error: rejection });
        rawErrors.push({
          row: index + 1,
          field: 'contact_phone',
          value: contact.phone,
          message: rejection,
        });
      } else {
        accepted.push(contact.ref);
      }
    });

    const providerBatchRef = `mem-batch-${this.nextBatchSeq++}`;

    // Matches Raya's `POST /batch` response. `data[]` holds PII; never return it as-is.
    const rawCreate: Record<string, unknown> = {
      status: accepted.length > 0 ? 'success' : 'failed',
      message: 'batch created',
      batchId: providerBatchRef,
      totalRows: input.contacts.length,
      validRows: accepted.length,
      invalidRows: rejected.length,
      contactsInserted: accepted.length,
      errors: rawErrors,
      data: input.contacts.map((c) => ({
        ref: c.ref,
        contact_name: c.name,
        contact_phone: c.phone,
      })),
    };
    // `webhook_url` is not whitelisted, so curation must drop it.
    const rawStart: Record<string, unknown> = {
      id: providerBatchRef,
      status: 'Active',
      total_contacts: accepted.length,
      completed_contacts: 0,
      unanswered_contacts: accepted.length,
      schedule: input.startOptions['schedule'] ?? null,
      max_retries: input.startOptions['max_retries'] ?? null,
      concurrency: input.startOptions['max_concurrent_calls'] ?? null,
      retry_after_hrs: input.startOptions['retry_after_hrs'] ?? null,
      webhook_url: 'https://internal.example.com/hooks/mem',
    };

    return ok({
      providerBatchRef,
      accepted,
      rejected,
      providerResponse: {
        create: brandCuratedProviderResponse(
          pickWhitelisted(rawCreate, CREATE_RESPONSE_PERSIST_KEYS),
        ),
        start: brandCuratedProviderResponse(pickWhitelisted(rawStart, START_RESPONSE_PERSIST_KEYS)),
      },
    });
  }
}
