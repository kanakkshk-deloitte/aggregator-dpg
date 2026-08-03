/**
 * Bulk Row Processor — per-row processing inside the bulk-upload pipeline.
 *
 * Per onboarding-implementation.md §3.3:
 *   1. Pull job { uploadId, aggregatorId, rowIndex, rawRow, payload }.
 *   2. Validate against the schema pinned on bulk_uploads.
 *   3. Normalise phone (E.164) and email (lowercase).
 *   4. INSERT participant ON CONFLICT (aggregator_id, participant_id) DO NOTHING.
 *   5. Run Lua script (§7) for atomic SADD + counter INCR + error HSET.
 *   6. If processed_count == total && reader_done → enqueue Finaliser.
 *
 * Outcome categories:
 *   passed   = INSERT succeeded
 *   skipped  = duplicate (ON CONFLICT)
 *   failed   = validation | normalisation | system_error
 */

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  runBulkRowCommit,
  type BulkFinaliseJob,
  type BulkRowProcessJob,
} from '@aggregator-dpg/queue';
import { PostgresParticipantsWriter } from '@aggregator-dpg/participants-writer/postgres';
import type { ParticipantsWriterBase } from '@aggregator-dpg/participants-writer/interface';
import { getDb, schema } from '../db.js';
import { getSchemaLoader } from '../services/schema-loader.js';
import { getRedis } from '../services/redis.js';
import { enqueueFinalise } from '../services/bulk-queue.js';
import { normalisePhone, normaliseEmail } from '../services/phone.js';
import { getNetworkConfig } from '../services/network-config.js';
import { getSignalStackWriter } from '../services/signalstack.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

let participantsWriter: ParticipantsWriterBase | null = null;
function getParticipantsWriter(): ParticipantsWriterBase {
  if (participantsWriter) return participantsWriter;
  participantsWriter = new PostgresParticipantsWriter(getDb());
  return participantsWriter;
}

/** Test helper — override the writer (e.g., inject a fake). */
export function _setParticipantsWriter(w: ParticipantsWriterBase | null): void {
  participantsWriter = w;
}

/**
 * Returns the set of participant types declared by the active network
 * (e.g. `seeker`/`provider` for blue/purple, `tourist`/`practitioner`
 * for orange_dot). Read once at network-config load — the network
 * loader caches the result for the lifetime of the worker.
 */
async function loadValidParticipantTypes(): Promise<Set<string>> {
  const cfg = await getNetworkConfig();
  return new Set(cfg.domainIds);
}

type ErrorCategory =
  | 'validation'
  | 'normalisation'
  | 'duplicate'
  | 'limit_reached'
  | 'owned_elsewhere'
  | 'system_error';

interface RowOutcome {
  outcome: 'passed' | 'skipped' | 'failed';
  category: ErrorCategory | null;
  reasons: string[];
}

const PROGRESS_FLUSH_EVERY = 500;

export async function processBulkRow(job: BulkRowProcessJob): Promise<RowOutcome> {
  const log = logger.child({
    operation: 'bulkRowProcess',
    upload_id: job.uploadId,
    row_index: job.rowIndex,
  });

  // Job payload carries the schema ref + participant type pinned by the File
  // Processor — no per-row SELECT on bulk_uploads needed. Status guards live
  // in the Finaliser and the File Processor entry guard; stale row jobs are a
  // non-issue here because the Lua commit script + jobId dedup absorb replays.
  const validTypes = await loadValidParticipantTypes();
  if (!validTypes.has(job.participantType)) {
    return await commit(
      job,
      {
        outcome: 'failed',
        category: 'system_error',
        reasons: [`invalid participant_type: ${job.participantType}`],
      },
      log,
    );
  }

  // 1. Schema validation. Load schema + validator together (both cached
  // by the loader) so we can pre-split comma-joined array cells before Ajv
  // runs. Ajv's `coerceTypes: 'array'` wraps a single string into a
  // one-element array but does NOT split on `,` — that's our job.
  const ref = { id: job.schemaId, version: job.schemaVersion };
  const loader = getSchemaLoader();
  const [validatorResult, schemaResult] = await Promise.all([
    loader.getValidator(ref),
    loader.getSchema(ref),
  ]);
  if (!validatorResult.success) {
    return await commit(
      job,
      {
        outcome: 'failed',
        category: 'system_error',
        reasons: [`schema_load_failed: ${validatorResult.error.code}`],
      },
      log,
    );
  }
  if (schemaResult.success) {
    const cfg = await getNetworkConfig();
    preprocessArrayCells(
      job.payload,
      schemaResult.value,
      cfg.aggregator.network.csv_array_delimiter,
    );
    // Strip every empty cell, required or not. Empty cells reaching Ajv
    // trip `type`/`enum`/`minItems`/`minLength` even when the field
    // wasn't filled in by the operator. Signals accepts missing keys
    // (item_state is treated as partial) and classifies the resulting
    // item as `draft`. Required-field gaps surface as Ajv `required`
    // errors below — those are dropped so the row passes through.
    stripAllEmptyCells(job.payload);
  }

  // Schema validation is advisory at this layer. Required-field gaps
  // are NOT a failure: signals' /admin/participant accepts partial
  // item_state and classifies the resulting item as `draft`. We still
  // surface TYPE / FORMAT / PATTERN / ENUM mismatches as row failures
  // because signals would 400 on them anyway and the local check gives
  // a faster error path. Missing-required-only failures pass through —
  // signals handles them.
  const validate = validatorResult.value;
  if (!validate(job.payload)) {
    const reasons = blockingValidationReasons(validate.errors ?? []);
    if (reasons.length > 0) {
      return await commit(
        job,
        {
          outcome: 'failed',
          category: 'validation',
          reasons,
        },
        log,
      );
    }
  }

  // 2. Normalisation. Auto-allocate a UUID when the row carries no explicit
  // `participant_id` — keeps the `(aggregator, type, participant_id)` unique
  // index satisfied while letting the participant schema decide whether the
  // field is a meaningful business id or not.
  const rawParticipantId = String(job.payload['participant_id'] ?? '').trim();
  const participantId = rawParticipantId.length > 0 ? rawParticipantId : randomUUID();

  // Identity selectors come from the resolved network config — sniffer
  // picks them up from the schema, or aggregator.config.yaml overrides
  // them. Different signalstack networks (blue / purple / yellow) use
  // different field names; the worker stays generic.
  const networkCfg = await getNetworkConfig();
  const domainCfg = networkCfg.domains[job.participantType];
  if (!domainCfg) {
    return await commit(
      job,
      {
        outcome: 'failed',
        category: 'system_error',
        reasons: [`unknown domain '${job.participantType}' for network ${networkCfg.network.id}`],
      },
      log,
    );
  }
  const phoneSourceKey = domainCfg.identity.phone;
  const emailSourceKey = domainCfg.identity.email;
  const phoneRaw =
    typeof job.payload[phoneSourceKey] === 'string' ? (job.payload[phoneSourceKey] as string) : '';
  let phoneNormalised: string | null = null;
  if (phoneRaw) {
    const phone = normalisePhone(phoneRaw);
    if (!phone.ok) {
      return await commit(
        job,
        {
          outcome: 'failed',
          category: 'normalisation',
          reasons: [`phone: ${phone.error.message}`],
        },
        log,
      );
    }
    phoneNormalised = phone.value;
  }
  // Email is optional in IdentitySelectors — domains like orange_dot's
  // `tourist` have no email field. Skip the lookup when undefined;
  // dedup degrades to phone-only.
  const emailNormalised = normaliseEmail(
    emailSourceKey && typeof job.payload[emailSourceKey] === 'string'
      ? (job.payload[emailSourceKey] as string)
      : null,
  );

  // 3. Persist via the participants-writer wrapper (shared by bulk + link).
  let outcome: RowOutcome;
  const writeResult = await getParticipantsWriter().writeBulkRow({
    aggregatorId: job.aggregatorId,
    type: job.participantType,
    participantId,
    data: job.payload,
    phone: phoneNormalised,
    email: emailNormalised,
    sourceBulkUploadId: job.uploadId,
    sourceRowIndex: job.rowIndex,
  });
  if (writeResult.success) {
    if (writeResult.value.outcome === 'passed') {
      outcome = { outcome: 'passed', category: null, reasons: [] };
    } else {
      outcome = {
        outcome: 'skipped',
        category: 'duplicate',
        reasons: [`participant_id '${participantId}' already registered for this aggregator`],
      };
    }

    // Outward signalstack push. The local participant write is now committed,
    // so a push failure can NOT roll back the row — instead we flip this
    // row's outcome to `failed` so it surfaces in errors.csv alongside any
    // validation / normalisation failures. Operators see one consistent
    // signal: a row only counts as "passed" once signalstack has it too.
    const push = await pushToSignalStack(job, participantId, phoneNormalised, emailNormalised, log);
    if (!push.success) {
      // `push.message` already includes the upstream's own error text when
      // signalstack returned a JSON body (e.g.
      // `signalstack onboard returned 400: INVALID_ITEM_STATE: …`). Surface
      // it directly so operators see the actual rejection reason in
      // errors.csv instead of a generic status-code string.
      // The per-user profile cap (signals #349) is a user/data condition, not a
      // system fault — categorise it distinctly so errors.csv reads clearly.
      const category: ErrorCategory = push.ownedElsewhere
        ? 'owned_elsewhere'
        : push.code === 'SIGNALSTACK_PROFILE_LIMIT_REACHED'
          ? 'limit_reached'
          : 'system_error';
      outcome = {
        outcome: 'failed',
        category,
        reasons: [`signalstack [${push.code}]: ${push.message}`],
      };
    }
  } else {
    log.error({
      status: 'failure',
      sub: 'participants.write',
      error: writeResult.error.message,
    });
    outcome = {
      outcome: 'failed',
      category: 'system_error',
      reasons: [`db: ${writeResult.error.message}`],
    };
  }

  return await commit(job, outcome, log);
}

/**
 * Atomically commit the row outcome to Redis (Lua) + flush DB counters
 * periodically + check completion.
 */
async function commit(
  job: BulkRowProcessJob,
  outcome: RowOutcome,
  log: typeof logger,
): Promise<RowOutcome> {
  // Only `failed` outcomes get a payload — `skipped` (e.g. duplicate
  // participant) is dedup, not an error, and must not appear in errors.csv.
  // raw_row is reconstructed by the Finaliser from `bu:{id}:lines` keyed on
  // row_index, so it does NOT travel in the per-row job payload anymore.
  const errorPayload =
    outcome.outcome === 'failed'
      ? JSON.stringify({
          row_index: job.rowIndex,
          reasons: outcome.reasons,
          error_category: outcome.category,
        })
      : '';

  const result = await runBulkRowCommit(
    getRedis(),
    job.uploadId,
    job.rowIndex,
    outcome.outcome,
    errorPayload,
    config.BULK_UPLOAD_REDIS_TTL_SECONDS,
  );

  if (result.wasNew === 0) {
    // Replay: row already committed earlier. Skip side-effect bookkeeping.
    log.info({ status: 'replay', outcome: outcome.outcome });
    return outcome;
  }

  // Heartbeat: bump last_progress_at every PROGRESS_FLUSH_EVERY rows so the
  // watchdog can detect stalled jobs. Counters live in Redis only — the
  // bulk_uploads counter columns were dropped in migration 0009.
  if (result.processed % PROGRESS_FLUSH_EVERY === 0 || result.processed === result.total) {
    await bumpHeartbeat(job.uploadId).catch((err) => {
      log.warn({ status: 'warn', sub: 'heartbeat', error: (err as Error).message });
    });
  }

  // Trigger Finaliser when last row is in.
  if (result.total > 0 && result.processed === result.total && result.readerDone === 1) {
    await enqueueFinalise({ uploadId: job.uploadId } satisfies BulkFinaliseJob);
  }

  log.info({
    status: 'success',
    outcome: outcome.outcome,
    category: outcome.category,
    processed: result.processed,
    total: result.total,
    reader_done: result.readerDone,
  });
  return outcome;
}

/**
 * Best-effort outward push of the freshly-inserted participant to signalstack.
 *
 * Sync-awaited (one HTTP call per row) so we can log a deterministic outcome
 * per row, but failures NEVER alter the local participant write result —
 * signalstack is treated as a downstream sink, not a transactional partner.
 * Returns void; status is observable via structured logs.
 */
type SignalStackPushResult =
  | { success: true }
  | { success: false; code: string; message: string; ownedElsewhere?: boolean };

export async function pushToSignalStack(
  job: BulkRowProcessJob,
  participantId: string,
  phone: string | null,
  email: string | null,
  log: typeof logger,
): Promise<SignalStackPushResult> {
  const ss = getSignalStackWriter();
  // Signalstack disabled in this env — treat as success so the row is not
  // marked failed when the operator deliberately turned the push off.
  if (!ss) return { success: true };

  // Resolve the aggregator's signalstack org id from the DB mirror written
  // by the approval flow + login-time backfill. The worker carries no JWT,
  // so the `signalstack_org_id` claim is unreachable here — `aggregators`
  // is the only authoritative source available offline.
  const orgIdRow = await getDb()
    .select({ signalstackOrgId: schema.aggregators.signalstackOrgId })
    .from(schema.aggregators)
    .where(eq(schema.aggregators.id, job.aggregatorId))
    .limit(1);
  const signalstackOrgId = orgIdRow[0]?.signalstackOrgId ?? null;
  if (!signalstackOrgId) {
    log.error({
      status: 'failure',
      sub: 'signalstack.push',
      code: 'SIGNALSTACK_ORG_NOT_REGISTERED',
      aggregator_id: job.aggregatorId,
    });
    return {
      success: false,
      code: 'SIGNALSTACK_ORG_NOT_REGISTERED',
      message:
        'aggregator has no signalstack_org_id on file; ask the aggregator owner to sign into the portal once so the backfill records it',
    };
  }

  // Identity selectors + item_type come from the resolved network
  // config so the worker stays generic across signalstack networks.
  const networkCfg = await getNetworkConfig();
  const domainCfg = networkCfg.domains[job.participantType];
  if (!domainCfg) {
    log.error({
      status: 'failure',
      sub: 'signalstack.push',
      code: 'UNKNOWN_DOMAIN',
      domain: job.participantType,
      network_id: networkCfg.network.id,
    });
    return {
      success: false,
      code: 'UNKNOWN_DOMAIN',
      message: `domain '${job.participantType}' not declared in network ${networkCfg.network.id}`,
    };
  }
  const nameSourceKey = domainCfg.identity.name;
  const phoneSourceKey = domainCfg.identity.phone;
  const name =
    typeof job.payload[nameSourceKey] === 'string'
      ? (job.payload[nameSourceKey] as string)
      : participantId;
  const phoneFromBody =
    typeof job.payload[phoneSourceKey] === 'string'
      ? (job.payload[phoneSourceKey] as string)
      : phone;
  const pushPhone = phone ?? phoneFromBody;
  const result = await ss.onboard({
    actingOrgId: signalstackOrgId,
    name,
    ...(pushPhone ? { phoneNumber: pushPhone } : {}),
    ...(email ? { email } : {}),
    // Aggregator-level consent captured at registration is the legal basis
    // for the bulk-row push; signalstack still expects these flags per-row
    // so we hardcode `true`. Surface as CSV columns if signalstack ever
    // demands per-row participant consent.
    terms_accepted: networkCfg.aggregator.onboarding.presume_consent,
    privacy_accepted: networkCfg.aggregator.onboarding.presume_consent,
    channel: 'bulk',
    source_id: job.uploadId,
    network: config.SIGNALSTACK_ITEM_NETWORK,
    domain: job.participantType,
    item_type: domainCfg.itemType,
    // Always pass the row's profile cells through verbatim. Signals
    // accepts partial item_state and classifies the resulting item as
    // `draft` when required fields are missing — that's signals' job,
    // not ours. Aggregator stays a thin pass-through.
    profile: buildSignalStackItemState(job.participantType, job.payload, pushPhone, domainCfg),
  });
  if (!result.success) {
    log.error({
      status: 'failure',
      sub: 'signalstack.push',
      error: result.error.message,
      code: result.error.code,
    });
    return {
      success: false,
      code: result.error.code,
      message: result.error.message,
    };
  }
  // A 2xx with `owned_elsewhere` means signals recognised the person under a
  // DIFFERENT aggregator and created no item here — it is NOT a successful
  // onboard. The link path already surfaces this; the bulk path must too, or
  // the row would be miscounted as `passed`. Fail the row with a clear reason.
  if (result.value.owned_elsewhere) {
    log.warn({
      status: 'failure',
      sub: 'signalstack.push',
      reason: 'owned_elsewhere',
      user_id: result.value.user_id,
    });
    return {
      success: false,
      code: 'SIGNALSTACK_OWNED_ELSEWHERE',
      message: 'participant is already registered under a different aggregator',
      ownedElsewhere: true,
    };
  }
  log.info({
    status: 'success',
    sub: 'signalstack.push',
    user_id: result.value.user_id,
    profile_item_id: result.value.profile_item_id,
    onboarded_at: result.value.onboarded_at,
  });
  return { success: true };
}

/**
 * Build the `item_state` block sent to signalstack from a bulk-upload row.
 *
 * Aggregator participant schemas already use the same field names as the
 * upstream signalstack profile item_state, so the row payload flows
 * through unchanged — we only override the phone field (chosen via the
 * domain's identity selectors) so signalstack stores the E.164 form the
 * writer resolved upstream, not whatever raw value the CSV cell carried.
 */
function buildSignalStackItemState(
  _domain: string,
  body: Record<string, unknown>,
  pushPhone: string | null,
  domainCfg: { identity: { phone: string } },
): Record<string, unknown> {
  const itemState: Record<string, unknown> = { ...body };

  // Keep the raw body value when present — signalstack validates the
  // phone field against the network's own pattern (purple_dot expects
  // `^[0-9]{10}$`, blue_dot expects E.164). The E.164 form is already
  // carried up-stack as the user.phone_number identity arg, so the
  // override here is only a fallback for empty cells.
  const rawPhone = body[domainCfg.identity.phone];
  if (pushPhone && (typeof rawPhone !== 'string' || rawPhone.length === 0)) {
    itemState[domainCfg.identity.phone] = pushPhone;
  }

  return itemState;
}

/**
 * Mutates `payload` in place: for every schema property declared with
 * `type: 'array'`, if the cell arrived as a string (CSV form), split it on
 * commas into a trimmed array. Empty cells become empty arrays. Non-string
 * values are left untouched. Worker complement to Ajv `coerceTypes: 'array'`
 * which wraps a string into a one-element array but never splits on commas.
 */
function preprocessArrayCells(
  payload: Record<string, unknown>,
  jsonSchema: Record<string, unknown>,
  delimiter: string,
): void {
  const props = jsonSchema['properties'];
  if (!props || typeof props !== 'object') return;
  for (const [field, def] of Object.entries(props as Record<string, Record<string, unknown>>)) {
    if (def?.['type'] !== 'array') continue;
    const cell = payload[field];
    if (typeof cell !== 'string') continue;
    payload[field] = cell
      .split(delimiter)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
}

/** Minimal structural shape of an Ajv validation error (subset we read). */
export interface SchemaValidationError {
  keyword?: string;
  instancePath?: string;
  schemaPath?: string;
  message?: string;
}

/**
 * Reduce Ajv errors to the human-readable reasons that should FAIL a bulk row.
 *
 * Required-field gaps are NOT failures at this layer — signals accepts partial
 * `item_state` and classifies the item as `draft`. Every other error
 * (type/format/pattern/enum/additionalProperties/minLength/minItems/…) is
 * surfaced so the row fails fast before reaching signals.
 *
 * @param errors - Ajv `validate.errors` (or `[]`).
 * @returns One reason string per blocking (non-`required`) error; empty when
 *   the only failures were missing required fields.
 */
export function blockingValidationReasons(errors: readonly SchemaValidationError[]): string[] {
  return errors
    .filter((e) => e.keyword !== 'required')
    .map((e) => `${e.instancePath || e.schemaPath}: ${e.message ?? 'invalid'}`);
}

/**
 * Strips ALL empty cells from the payload — empty strings, empty
 * arrays, null, undefined. Used by the bulk row processor so partial
 * profiles can pass through to signals without tripping Ajv's
 * content-shape checks (type/enum/minItems/minLength) on cells the
 * operator never filled in. Signals' classifier handles partial
 * item_state directly and classifies the resulting item as `draft`.
 *
 * Note: the public link path (apps/api/.../public-registration-links.ts)
 * keeps its own required-only strip helper — that path validates with a
 * different (interactive) contract, so the divergence is intentional.
 *
 * @param payload - The row payload; mutated in place.
 */
export function stripAllEmptyCells(payload: Record<string, unknown>): void {
  for (const [field, value] of Object.entries(payload)) {
    if (value === null || value === undefined) {
      delete payload[field];
      continue;
    }
    if (typeof value === 'string' && value.trim() === '') {
      delete payload[field];
      continue;
    }
    if (Array.isArray(value) && value.length === 0) {
      delete payload[field];
      continue;
    }
  }
}

/**
 * Heartbeat-only DB write — bumps `last_progress_at` so the watchdog can
 * detect stalled jobs. Counters live exclusively in Redis (live) and the
 * `onboarding` row (after `bulk-finalise`).
 */
async function bumpHeartbeat(uploadId: string): Promise<void> {
  await getDb()
    .update(schema.bulkUploads)
    .set({
      lastProgressAt: new Date(),
      updatedAt: sql`NOW()`,
    })
    .where(eq(schema.bulkUploads.id, uploadId));
}
