/**
 * Bulk row processor: handles one row of a bulk upload in the worker app.
 *
 * Steps:
 *   1. Validate the row against the schema pinned on the upload.
 *   2. Normalise phone (E.164) and email (lowercase).
 *   3. Push the row to Signals, which is the store of record.
 *   4. Commit the outcome to Redis with the atomic Lua script.
 *   5. Enqueue the finaliser when the last row is in and the reader is done.
 *
 * Outcomes:
 *   passed  = Signals accepted the push
 *   failed  = validation | normalisation | duplicate | limit_reached |
 *             owned_elsewhere | system_error
 *   skipped = not produced on this path
 */

import { describeSchemaIssue } from '@aggregator-dpg/network-config/field-errors';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  runBulkRowCommit,
  type BulkFinaliseJob,
  type BulkRowProcessJob,
} from '@aggregator-dpg/queue';
import { getDb, schema } from '../db.js';
import { getSchemaLoader } from '../services/schema-loader.js';
import { getRedis } from '../services/redis.js';
import { enqueueFinalise } from '../services/bulk-queue.js';
import { normalisePhone, normaliseEmail } from '@aggregator-dpg/shared-primitives/phone';
import { getNetworkConfig } from '../services/network-config.js';
import { getSignalStackWriter } from '../services/signalstack.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  GEO_LOCATION_COLUMN,
  parseGeoLocation,
  schemaOwnsColumn,
  type ParsedGeoLocation,
} from '@aggregator-dpg/shared-primitives/bulk-columns';
import { buildSignalStackItemState } from '@aggregator-dpg/signalstack-writer/item-state';

/**
 * Returns the participant types declared by the active network.
 *
 * The network loader caches the config for the life of the worker.
 */
async function loadValidParticipantTypes(): Promise<Set<string>> {
  const cfg = await getNetworkConfig();
  return new Set(cfg.domainIds);
}

type ErrorCategory =
  | 'validation'
  | 'normalisation'
  // Set when Signals reports the person already exists.
  | 'duplicate'
  | 'limit_reached'
  | 'owned_elsewhere'
  | 'system_error';

interface RowOutcome {
  /** `skipped` is not produced on this path. */
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

  // The job carries the schema ref and participant type set by the file
  // processor. Replays are absorbed by the Lua commit script and jobId dedup.
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

  // 1. Schema validation. Load the schema too, so array cells can be split
  // before Ajv runs; Ajv does not split delimited strings.
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
  // 1b. Remove the well-known geo column before Ajv runs. It is not a schema
  // property, so it would fail `additionalProperties: false` and would leak
  // into `item_state`. If the schema declares the column itself, leave it.
  const schemaOwnsGeo = schemaOwnsColumn(
    schemaResult.success ? (schemaResult.value as Record<string, unknown>) : null,
    GEO_LOCATION_COLUMN,
  );
  const geoRaw = schemaOwnsGeo ? undefined : job.payload[GEO_LOCATION_COLUMN];
  if (!schemaOwnsGeo) delete job.payload[GEO_LOCATION_COLUMN];
  const geo = parseGeoLocation(geoRaw);
  if (geo.status === 'invalid') {
    // Not a row failure: Signals geocodes the address instead. Failing would
    // force a re-upload, which duplicates rows because `onboard` always inserts.
    // The raw cell is not logged because coordinates are PII.
    log.warn({
      status: 'skipped',
      sub: 'geo_location.ignored',
      reason: geo.reason,
    });
  }

  if (schemaResult.success) {
    const cfg = await getNetworkConfig();
    preprocessArrayCells(
      job.payload,
      schemaResult.value,
      cfg.aggregator.network.csv_array_delimiter,
    );
    // Drop empty cells so Ajv does not fail type/enum/length checks on
    // fields the operator left blank. Signals accepts partial item_state.
    stripAllEmptyCells(job.payload);
  }

  // Missing required fields do not fail the row; Signals stores it as a
  // draft. Type, format, pattern and enum errors do fail the row, since
  // Signals would reject them too.
  const validate = validatorResult.value;
  if (!validate(job.payload)) {
    const reasons = blockingValidationReasons(
      validate.errors ?? [],
      schemaResult.success ? schemaResult.value : undefined,
    );
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

  // 2. Normalisation. Use a new UUID when the row has no `participant_id`.
  // It is the name fallback sent to Signals.
  const rawParticipantId = String(job.payload['participant_id'] ?? '').trim();
  const participantId = rawParticipantId.length > 0 ? rawParticipantId : randomUUID();

  // Identity field names come from the network config.
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
  // Some domains have no email field.
  const emailNormalised = normaliseEmail(
    emailSourceKey && typeof job.payload[emailSourceKey] === 'string'
      ? (job.payload[emailSourceKey] as string)
      : null,
  );

  // 3. Push to Signals. Its response decides the row outcome. There is no
  // local duplicate check.
  let outcome: RowOutcome;
  const push = await pushToSignalStack(
    job,
    participantId,
    phoneNormalised,
    emailNormalised,
    log,
    geo.status === 'ok' ? geo.value : null,
  );
  if (push.success) {
    outcome = { outcome: 'passed', category: null, reasons: [] };
  } else {
    // Data rejections are row errors; platform faults are `system_error`.
    const category = categoriseSignalsRejection(push);
    outcome = { outcome: 'failed', category, reasons: signalsRejectionReasons(push, category) };
  }

  return await commit(job, outcome, log);
}

/**
 * Commits the row outcome to Redis, bumps the heartbeat, and enqueues the finaliser when done.
 */
async function commit(
  job: BulkRowProcessJob,
  outcome: RowOutcome,
  log: typeof logger,
): Promise<RowOutcome> {
  // Only `failed` outcomes get an error payload. The finaliser rebuilds the raw
  // row from `bu:{id}:lines` by row_index.
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
    // Replay: the row was already committed.
    log.info({ status: 'replay', outcome: outcome.outcome });
    return outcome;
  }

  // Bump last_progress_at every PROGRESS_FLUSH_EVERY rows so the watchdog can
  // detect stalled jobs. Counters live in Redis only.
  if (result.processed % PROGRESS_FLUSH_EVERY === 0 || result.processed === result.total) {
    await bumpHeartbeat(job.uploadId).catch((err) => {
      log.warn({ status: 'warn', sub: 'heartbeat', error: (err as Error).message });
    });
  }

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
 * Result of pushing one row to Signals.
 */
type SignalStackPushResult =
  | { success: true }
  | {
      success: false;
      code: string;
      message: string;
      /**
       * Signals' own error sentence, without the prefixes in `message`.
       * Present only when Signals returned a JSON error body.
       */
      signalsMessage?: string;
      /** Signals' own error code (e.g. `INVALID_ITEM_STATE`), when it sent one. */
      upstreamCode?: string;
      /** Signals' per-field messages (`fields` on INVALID_ITEM_STATE), when it sent them. */
      signalsFields?: Record<string, string>;
      ownedElsewhere?: boolean;
    };

/**
 * Maps Signals error codes caused by row data to a row error category.
 *
 * Codes not listed here are treated as `system_error`.
 */
const SIGNALS_REJECTION_CATEGORY: Readonly<Record<string, ErrorCategory>> = {
  INVALID_ITEM_STATE: 'validation',
  FST_ERR_VALIDATION: 'validation',
  MISSING_IDENTIFIER: 'validation',
  AGE_REQUIRED: 'validation',
  USER_LEVEL_INCOMPLETE: 'validation',
  CONSENT_DECLINED: 'validation',
  // Signals already holds an under-18 age for this person. Minors onboard
  // through the portal, so the operator removes the row.
  U18_NOT_ALLOWED: 'validation',
  LOCATION_OUTSIDE_COUNTRY: 'validation',
  // The person already exists in another domain or with a clashing identity.
  DOMAIN_LOCKED: 'duplicate',
  USER_ALREADY_EXISTS: 'duplicate',
  IDENTITY_CONFLICT: 'duplicate',
  PROFILE_LIMIT_REACHED: 'limit_reached',
};

/**
 * Returns the error category for a failed push.
 *
 * Uses Signals' error code when present, else the writer's own code.
 */
function categoriseSignalsRejection(
  push: Extract<SignalStackPushResult, { success: false }>,
): ErrorCategory {
  if (push.ownedElsewhere) return 'owned_elsewhere';
  const byUpstream = push.upstreamCode ? SIGNALS_REJECTION_CATEGORY[push.upstreamCode] : undefined;
  if (byUpstream) return byUpstream;
  if (push.code === 'SIGNALSTACK_PROFILE_LIMIT_REACHED') return 'limit_reached';
  if (push.code === 'SIGNALSTACK_LOCATION_OUTSIDE_COUNTRY') return 'validation';
  return 'system_error';
}

/**
 * Builds the errors.csv reasons for a failed push.
 *
 * Row errors give one `field: message` line per field, or Signals' message.
 * System errors keep the code and the full upstream text.
 */
function signalsRejectionReasons(
  push: Extract<SignalStackPushResult, { success: false }>,
  category: ErrorCategory,
): string[] {
  if (category === 'system_error') return [`signalstack [${push.code}]: ${push.message}`];
  if (push.signalsFields) {
    const lines = Object.entries(push.signalsFields).map(([field, msg]) => `${field}: ${msg}`);
    if (lines.length > 0) return lines;
  }
  return [push.signalsMessage ?? push.message];
}

/**
 * Derives the participant's age and consent record from a bulk row.
 *
 * Reads `year_of_birth` or `age`. A minor (age 18 or under) gets neither age
 * nor consent, and accepts terms in the Signals app. An adult gets the accept
 * record only when the network presumes consent; otherwise `compliance` is omitted.
 */
function deriveAgeAndConsent(
  payload: Record<string, unknown>,
  presumeConsent: boolean,
): {
  ageNum: number | undefined;
  compliance: Array<{ key: string; value: boolean }> | undefined;
} {
  const coerceNum = (v: unknown): number | undefined => {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
      return Number(v);
    }
    return undefined;
  };
  const yearOfBirth = coerceNum(payload['year_of_birth']);
  const derivedAge =
    yearOfBirth !== undefined
      ? new Date().getUTCFullYear() - yearOfBirth
      : coerceNum(payload['age']);
  const rowIsMinor = derivedAge !== undefined && derivedAge <= 18;
  const ageNum = rowIsMinor ? undefined : derivedAge;
  const compliance =
    presumeConsent && !rowIsMinor
      ? [
          { key: 'user_terms', value: true },
          { key: 'user_privacy', value: true },
          { key: 'profile_creation', value: true },
        ]
      : undefined;
  return { ageNum, compliance };
}

/**
 * Maps a failed signalstack onboard into the row's push result.
 *
 * Keeps Signals' message, error code and per-field messages when present.
 *
 * @param error - The writer's failure, with optional Signals details.
 * @returns A failed {@link SignalStackPushResult}.
 */
function onboardFailure(error: {
  code: string;
  message: string;
  details?: unknown;
}): SignalStackPushResult {
  const { signalsMessage, upstreamCode, signalsFields } = (error.details ?? {}) as {
    signalsMessage?: unknown;
    upstreamCode?: unknown;
    signalsFields?: unknown;
  };
  return {
    success: false,
    code: error.code,
    message: error.message,
    ...(typeof signalsMessage === 'string' && signalsMessage ? { signalsMessage } : {}),
    ...(typeof upstreamCode === 'string' && upstreamCode ? { upstreamCode } : {}),
    ...(signalsFields && typeof signalsFields === 'object'
      ? { signalsFields: signalsFields as Record<string, string> }
      : {}),
  };
}

export async function pushToSignalStack(
  job: BulkRowProcessJob,
  participantId: string,
  phone: string | null,
  email: string | null,
  log: typeof logger,
  /**
   * Point from the row's `geo_location` cell, or null when absent or invalid.
   * When set, Signals stores it and skips geocoding.
   */
  geoLocation: ParsedGeoLocation | null = null,
): Promise<SignalStackPushResult> {
  const ss = getSignalStackWriter();
  // Signals push is disabled in this env; count the row as passed.
  if (!ss) return { success: true };

  // The worker has no JWT, so read the aggregator's Signals org id from the DB.
  const orgIdRow = await getDb()
    .select({ signalstackOrgId: schema.users.signalstackOrgId })
    .from(schema.users)
    .where(eq(schema.users.id, job.aggregatorId))
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

  // Identity fields and item_type come from the network config.
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
  // The bulk CSV has no per-row consent column. Consent is sent only via
  // `compliance`, which Signals treats as accept-only: a `false` value is
  // rejected with CONSENT_DECLINED.
  const presumeConsent = networkCfg.aggregator.onboarding.presume_consent;

  // Age and consent match the public link flow. Signals rejects consent
  // without an age on guardian-gated domains (AGE_REQUIRED) and rejects
  // minors server-to-server (U18_NOT_ALLOWED).
  const { ageNum, compliance } = deriveAgeAndConsent(job.payload, presumeConsent);
  const result = await ss.onboard({
    actingOrgId: signalstackOrgId,
    name,
    ...(pushPhone ? { phoneNumber: pushPhone } : {}),
    ...(email ? { email } : {}),
    ...(ageNum !== undefined ? { age: ageNum } : {}),
    ...(compliance ? { compliance } : {}),
    channel: 'bulk',
    source_id: job.uploadId,
    network: config.SIGNALSTACK_ITEM_NETWORK,
    domain: job.participantType,
    item_type: domainCfg.itemType,
    // Omitted rather than sent as `[]` when there is no point.
    ...(geoLocation ? { item_locations: [geoLocation] } : {}),
    // Profile cells pass through as-is. Signals stores partial items as drafts.
    profile: buildSignalStackItemState(job.payload, pushPhone, domainCfg.identity.phone),
  });
  if (!result.success) {
    log.error({
      status: 'failure',
      sub: 'signalstack.push',
      error: result.error.message,
      code: result.error.code,
    });
    return onboardFailure(result.error);
  }
  // A 2xx with `owned_elsewhere` means the person belongs to another
  // aggregator and no item was created. Fail the row.
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
 * Splits string cells of array-typed schema properties into trimmed arrays.
 *
 * Mutates `payload` in place. Empty parts are dropped; non-string values are left as-is.
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
  params?: Record<string, unknown>;
  message?: string;
}

/** A `required` error raised inside a conditional branch (`if` … `then`). */
function isConditionalRequired(e: SchemaValidationError): boolean {
  return e.keyword === 'required' && (e.schemaPath ?? '').includes('/then/');
}

/**
 * Returns the Ajv errors that should fail a bulk row, as readable reasons.
 *
 * Top-level `required` errors are dropped, since Signals stores partial items
 * as drafts. `required` errors inside an `if`/`then` branch are kept, because
 * Signals rejects those rows. The summary `if` error is dropped. All other
 * errors are kept.
 *
 * @param errors - Ajv `validate.errors` (or `[]`).
 * @param schema - The schema the row was validated against, for URL-field
 *   wording; optional.
 * @returns One reason string per blocking error; empty when the only failures
 *   were missing top-level required fields.
 */
export function blockingValidationReasons(
  errors: readonly SchemaValidationError[],
  schema?: unknown,
): string[] {
  return errors
    .filter((e) => e.keyword !== 'if' && (e.keyword !== 'required' || isConditionalRequired(e)))
    .map((e) => {
      // Signals' wording, keyed by dot path — the same `field: message` shape
      // errors.csv already uses for a Signals rejection (#904). A failed
      // pattern reads "Please enter a valid web address.", never the regex.
      const d = describeSchemaIssue(e, schema);
      return `${d.field || e.schemaPath || 'row'}: ${d.message}`;
    });
}

/**
 * Removes empty cells (blank strings, empty arrays, null, undefined) from a row.
 *
 * Lets partial rows pass Ajv without failing checks on blank cells.
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
 * Updates `last_progress_at` so the watchdog can detect stalled uploads.
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
