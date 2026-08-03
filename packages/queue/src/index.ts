/**
 * Queue surface for the bulk-upload + onboarding pipeline.
 *
 * Exposes:
 *   - QueueName constants (one per queue defined in the implementation
 *     design § BullMQ Queues).
 *   - Job payload type definitions, shared between enqueuer (API) and
 *     consumer (worker).
 *   - Connection factory that returns an ioredis client from REDIS_URL.
 *
 * BullMQ is intentionally not abstracted further — both API and worker
 * import this package and construct their own `Queue` / `Worker` instances
 * directly using these names + types.
 */

import { Redis } from 'ioredis';

// ─── Queue names ─────────────────────────────────────────────────────────────

export const QueueName = {
  /** File-level checks: download CSV, header validation, encoding, row count. */
  BulkFileProcess: 'bulk-file-process',
  /** Per-row processing: schema validate, dedup, INSERT participant. */
  BulkRowProcess: 'bulk-row-process',
  /** Run summary: stream errors.csv, UPDATE bulk_uploads, INSERT onboarding. */
  BulkFinalise: 'bulk-finalise',
  /** Periodic rollup of link_submission rows into onboarding. */
  LinkMetricsRollup: 'link-metrics-rollup',
  /** Hourly watchdog + retention sweep. */
  CronWatchdog: 'cron-watchdog',
} as const;

export type QueueName = (typeof QueueName)[keyof typeof QueueName];

// ─── Job payloads ────────────────────────────────────────────────────────────

export interface BulkFileProcessJob {
  uploadId: string;
  aggregatorId: string;
  s3Key: string;
  participantType: string;
  schemaId: string;
  schemaVersion: string;
}

export interface BulkRowProcessJob {
  uploadId: string;
  aggregatorId: string;
  rowIndex: number;
  /** Pinned schema id, propagated from File Processor so Row Processor avoids a per-row DB read. */
  schemaId: string;
  /** Pinned schema version, propagated from File Processor. */
  schemaVersion: string;
  /** Pinned participant type, propagated from File Processor. */
  participantType: string;
  /** Parsed payload after CSV → object conversion. */
  payload: Record<string, unknown>;
}

export interface BulkFinaliseJob {
  uploadId: string;
}

export interface LinkMetricsRollupJob {
  /** Tick timestamp (epoch ms) used as part of the jobId for dedupe. */
  tick: number;
}

export interface CronWatchdogJob {
  tick: number;
}

// ─── Redis connection ────────────────────────────────────────────────────────

export interface RedisConnectionOptions {
  /** redis://host:port[/db] — full URL form. Defaults to REDIS_URL env. */
  url?: string;
  /**
   * Per-request retry cap. Defaults to `null` (required for BullMQ queue
   * connections). Non-queue callers (e.g. the API rate limiter) should set a
   * finite value so a Redis outage fails fast instead of queueing forever.
   */
  maxRetriesPerRequest?: number | null;
  /**
   * Per-command timeout in ms. Unset for queue connections (BullMQ manages
   * its own). Set by callers that must bound a single command so a downed
   * Redis surfaces an error promptly rather than hanging the request.
   */
  commandTimeout?: number;
  /**
   * When `false`, commands issued while disconnected reject immediately
   * instead of buffering. Non-queue callers that fail open on Redis errors
   * should disable it so an outage never blocks the request path.
   */
  enableOfflineQueue?: boolean;
}

/**
 * Returns an ioredis instance. Defaults are configured for BullMQ (per its
 * docs, `maxRetriesPerRequest` MUST be `null` for queue connections); pass
 * overrides for non-queue callers that need fail-fast semantics.
 *
 * Caller owns the lifetime — call `.disconnect()` on shutdown.
 */
export function createRedisConnection(opts: RedisConnectionOptions = {}): Redis {
  const url = opts.url ?? process.env.REDIS_URL ?? 'redis://localhost:6379';
  return new Redis(url, {
    maxRetriesPerRequest: opts.maxRetriesPerRequest ?? null,
    enableReadyCheck: true,
    ...(opts.commandTimeout !== undefined ? { commandTimeout: opts.commandTimeout } : {}),
    ...(opts.enableOfflineQueue !== undefined
      ? { enableOfflineQueue: opts.enableOfflineQueue }
      : {}),
  });
}

// ─── Standard job options ────────────────────────────────────────────────────

export const DEFAULT_JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 1000 },
  removeOnComplete: { age: 3600 },
  removeOnFail: { age: 604800 },
} as const;

// ─── Bulk-upload Redis key namespace ─────────────────────────────────────────

/**
 * Every per-upload Redis key under the `bu:{uploadId}:*` namespace used by the
 * bulk pipeline. Some of these hold participant PII (`:lines` = raw CSV rows,
 * `:errors` = per-row error detail incl. the raw row), so this is the single
 * list to DEL on cleanup / terminal states — keeping the File Processor,
 * Finaliser, and watchdog from drifting apart.
 *
 * @param uploadId - bulk_uploads.id.
 * @returns The six fully-qualified Redis keys for this upload.
 */
export function bulkRedisKeys(uploadId: string): string[] {
  const ns = `bu:${uploadId}`;
  return [
    `${ns}:processed`,
    `${ns}:counters`,
    `${ns}:errors`,
    `${ns}:error_rows`,
    `${ns}:meta`,
    `${ns}:lines`,
  ];
}

// ─── Lua scripts ─────────────────────────────────────────────────────────────

export {
  runBulkRowCommit,
  bulkRowCommitScript,
  type BulkRowCommitResult,
  type BulkRowOutcome,
} from './lua-loader.js';
