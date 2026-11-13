/**
 * Campaign voice channel in `@aggregator-dpg/worker`.
 *
 * Runs one `voice` job: decrypt the open items (name, phone and the requested
 * item_state variables), build one Raya batch from items with a phone number,
 * dispatch it (create + start), and store each contact's accept or reject.
 * There is no polling; Raya owns the call outcome after dispatch.
 *
 * Retry safety: `markSubmitted` writes `submitted` and `providerBatchRef` in one
 * statement, so any item with a `providerBatchRef` means a batch already exists.
 * On retry the handler does not dispatch again; it marks items still `resolved`
 * as `submitted` under that batch. Accepted items are marked before
 * `setProviderResponse` so the guard is set as early as possible.
 *
 * Known gap: if the worker dies after `dispatch()` succeeds but before the first
 * `markSubmitted` commits, a retry dispatches again. Raya has no idempotency key;
 * `reuseExisting` narrows this window on retries.
 *
 * `AuthError` and `ValidationError` from `dispatch()` are terminal: the items
 * are marked `failed` with Raya's reason and the job is not retried, since a
 * retry would create another orphan batch. `UpstreamError` throws so BullMQ retries.
 *
 * Never logs contact PII; only counts and item ids.
 */
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import {
  AuthError,
  ValidationError,
  type BaseError,
} from '@aggregator-dpg/shared-primitives/errors';
import type {
  SignalStackDecryptedProfileRow,
  SignalStackDecryptedProfiles,
  SignalStackFetchDecryptedProfilesQuery,
} from '@aggregator-dpg/signalstack-writer/interface';
import type { VoiceContact, VoiceProviderBase } from '@aggregator-dpg/voice-provider/interface';
import { TERMINAL_ITEM_STATUSES, type ProcessingJob } from '../campaign-job-client.js';
import { chunkArray, truncateReason, type CampaignJobDeps } from './index.js';

/** Voice collaborators (decrypt + provider). */
export interface VoiceCollaborators {
  fetchDecryptedProfiles: (
    q: SignalStackFetchDecryptedProfilesQuery,
  ) => Promise<Result<SignalStackDecryptedProfiles, BaseError>>;
  provider: VoiceProviderBase;
}

/**
 * The voice job content fields this handler reads.
 *
 * Copy of the API's `VoiceContent`, since apps do not import each other.
 * The API validates `job.content` when the job is created.
 */
interface VoiceJobContent {
  agent_id: string;
  batch_name?: string;
  variables?: string[];
  schedule?: unknown;
  max_retries?: number;
  retry_after_hrs?: number;
  max_concurrent_calls?: number;
  selected_statuses?: string[];
}

/** Raya start-option keys passed through. Matches the API's `START_KEYS`. */
const START_OPTION_KEYS = [
  'schedule',
  'max_retries',
  'retry_after_hrs',
  'max_concurrent_calls',
  'selected_statuses',
] as const;

/**
 * Returns the Raya start options present in the voice content.
 *
 * @param content - The parsed voice job content.
 * @returns Record with only the supplied passthrough keys.
 */
function voiceStartOptions(content: VoiceJobContent): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of START_OPTION_KEYS) {
    const value = content[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Reads + minimally validates the voice job's `content` JSONB.
 *
 * @param content - The job's raw `content` column.
 * @returns The typed voice content.
 * @throws {Error} If `agent_id` is missing.
 */
function parseVoiceContent(content: Record<string, unknown>): VoiceJobContent {
  const agentId = content['agent_id'];
  if (typeof agentId !== 'string' || agentId.length === 0) {
    throw new Error('campaign voice job content missing agent_id');
  }
  return content as unknown as VoiceJobContent;
}

/**
 * Flattens `item_state` into the string-only variable map Raya expects.
 *
 * Arrays and objects are JSON-stringified; null and undefined are dropped.
 *
 * @param itemState - The decrypted item's `item_state`.
 * @returns Flattened `{ key: string }` call variables.
 */
function flattenVariables(itemState: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(itemState)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string') out[key] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = String(value);
    else out[key] = JSON.stringify(value);
  }
  return out;
}

/**
 * Builds the item failure reason for a rejected dispatch.
 *
 * Adds the top-level `message` from Raya's JSON body when present. Never
 * includes the raw body, which can contain contact PII.
 *
 * @param error - The typed error from `VoiceProviderBase.dispatch`.
 * @returns A reason string for `campaign_job_item.error_reason`, bounded by {@link truncateReason}.
 */
function describeDispatchFailure(error: BaseError): string {
  const body = error.details?.['body'];
  if (typeof body === 'string' && body.length > 0) {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const parsedMessage = parsed['message'];
      if (typeof parsedMessage === 'string' && parsedMessage.length > 0) {
        return truncateReason(`${error.message}: ${parsedMessage}`);
      }
    } catch {
      // Not JSON. Do not store the raw body; it can contain PII.
    }
  }
  return truncateReason(error.message);
}

/** Shared log fields stamped on every `campaign.voice` log line for one job. */
interface VoiceLogBase {
  operation: 'campaign.voice';
  job_id: string;
  org_id: string;
}

/**
 * Handles a failed `dispatch()` call.
 *
 * `AuthError` and `ValidationError` mark every contact `failed` and return.
 * Any other error is thrown so BullMQ retries.
 *
 * @param job - The job being processed.
 * @param deps - Injected job-client + logger.
 * @param contacts - The contacts included in the failed dispatch call.
 * @param error - The typed error from `VoiceProviderBase.dispatch`.
 * @param base - Shared log fields for this job (`operation`/`job_id`/`org_id`).
 * @throws {Error} Re-throws (wrapped) for a transient dispatch failure.
 */
async function handleDispatchFailure(
  job: ProcessingJob,
  deps: CampaignJobDeps,
  contacts: VoiceContact[],
  error: BaseError,
  base: VoiceLogBase,
): Promise<void> {
  if (!(error instanceof AuthError || error instanceof ValidationError)) {
    // Transient: retry.
    throw new Error(`campaign voice dispatch failed: ${error.code}: ${error.message}`);
  }
  // Rejected request: terminal, since a retry would create another batch.
  const reason = describeDispatchFailure(error);
  for (const contact of contacts) {
    await deps.client.markItem(job.id, contact.ref, 'failed', reason);
  }
  deps.log.warn({
    ...base,
    status: 'failed',
    reason: 'dispatch_rejected',
    error_code: error.code,
    error_type: error.constructor.name,
    dispatched: contacts.length,
  });
}

/**
 * Decrypts the job's open items in chunks, marks each, and bumps the heartbeat per chunk.
 *
 * Items in a terminal status are skipped. Throws on a decrypt failure so BullMQ retries.
 *
 * @param job - The job being processed.
 * @param deps - Injected collaborators (client, config).
 * @param voice - The voice collaborators (already null-checked by the caller).
 * @param fields - `item_state` field projection (`content.variables`); `undefined` = full item_state.
 * @returns The resolved profile rows (owned items only).
 */
async function decryptVoiceItems(
  job: ProcessingJob,
  deps: CampaignJobDeps,
  voice: VoiceCollaborators,
  fields: string[] | undefined,
): Promise<SignalStackDecryptedProfileRow[]> {
  const openItemIds = job.items
    .filter((i) => !TERMINAL_ITEM_STATUSES.includes(i.status))
    .map((i) => i.itemId);
  const resolvedRows: SignalStackDecryptedProfileRow[] = [];

  for (const chunk of chunkArray(openItemIds, deps.config.decryptChunk)) {
    const query: SignalStackFetchDecryptedProfilesQuery = {
      actingOrgId: job.signalstackOrgId,
      itemIds: chunk,
      contact: ['name', 'phone'],
      ...(fields ? { fields } : {}),
      ...(job.requestId ? { requestId: job.requestId } : {}),
    };
    const result = await voice.fetchDecryptedProfiles(query);
    if (!result.success) {
      throw new Error(
        `campaign voice decrypt failed: ${result.error.code}: ${result.error.message}`,
      );
    }
    const { profiles, skipped } = result.value;

    for (const p of profiles) {
      resolvedRows.push(p);
      await deps.client.markItem(job.id, p.item_id, 'resolved');
    }
    for (const missing of skipped) {
      await deps.client.markItem(job.id, missing, 'skipped_not_owned', 'not_owned_by_org');
    }
    await deps.client.heartbeat(job.id);
  }
  return resolvedRows;
}

/**
 * Runs the voice channel for one job.
 *
 * The caller rolls the job status up from the item statuses this leaves.
 *
 * @param job - The job to process (`job.channel === 'voice'`).
 * @param deps - Injected job-client, voice collaborators, config, logger.
 * @throws {Error} If `deps.voice` is not set, decrypt fails, or dispatch fails transiently.
 */
export async function runVoiceForJob(job: ProcessingJob, deps: CampaignJobDeps): Promise<void> {
  const voice = deps.voice;
  if (!voice) {
    throw new Error('campaign voice channel requires voice collaborators (deps.voice)');
  }
  const base: VoiceLogBase = {
    operation: 'campaign.voice',
    job_id: job.id,
    org_id: job.signalstackOrgId,
  };

  // A stored batch ref means a batch already exists. Do not dispatch again;
  // mark items still `resolved` as submitted under that batch.
  const existingBatchId = job.items.find((i) => i.providerBatchRef)?.providerBatchRef;
  if (existingBatchId) {
    const unresolved = job.items.filter((i) => i.status === 'resolved');
    for (const item of unresolved) {
      await deps.client.markSubmitted(job.id, item.itemId, { providerBatchRef: existingBatchId });
    }
    deps.log.info({
      ...base,
      status: 'skipped',
      reason: 'batch_already_created',
      resumed: unresolved.length,
    });
    return;
  }

  const content = parseVoiceContent(job.content);
  const resolvedRows = await decryptVoiceItems(job, deps, voice, content.variables);

  const contacts: VoiceContact[] = [];
  for (const row of resolvedRows) {
    const phone = row.contact?.phone?.value;
    if (!phone || phone.trim().length === 0) {
      await deps.client.markItem(job.id, row.item_id, 'skipped_no_contact', 'no_phone');
      continue;
    }
    contacts.push({
      ref: row.item_id,
      name: row.contact?.name?.value ?? '',
      phone,
      variables: flattenVariables(row.item_state),
    });
  }

  if (contacts.length === 0) {
    // No item has a phone number; all are already marked.
    deps.log.warn({ ...base, status: 'skipped', reason: 'no_contactable_items', dispatched: 0 });
    return;
  }

  const result = await voice.provider.dispatch({
    agentRef: content.agent_id,
    batchName: content.batch_name ?? `campaign-${job.id}`,
    contacts,
    startOptions: voiceStartOptions(content),
    // Look up an existing batch only on a retry. An unknown attempt counts as the first.
    reuseExisting: (deps.attempt?.attempt ?? 1) > 1,
  });
  if (!result.success) {
    await handleDispatchFailure(job, deps, contacts, result.error, base);
    return;
  }

  // Mark accepted items before `setProviderResponse`: only `markSubmitted`
  // stores the batch ref that the retry guard checks.
  for (const ref of result.value.accepted) {
    await deps.client.markSubmitted(job.id, ref, {
      providerBatchRef: result.value.providerBatchRef,
    });
  }
  for (const rejection of result.value.rejected) {
    await deps.client.markItem(job.id, rejection.ref, 'failed', rejection.error);
  }
  await deps.client.setProviderResponse(job.id, result.value.providerResponse);

  deps.log.info({
    ...base,
    status: 'success',
    dispatched: contacts.length,
    accepted: result.value.accepted.length,
    rejected: result.value.rejected.length,
  });
}
