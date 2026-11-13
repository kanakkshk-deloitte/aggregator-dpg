/**
 * Queue surface for the bulk-upload and campaign pipelines (`@aggregator-dpg/queue`).
 *
 * Exposes:
 *   - QueueName constants, one per queue.
 *   - Job payload type definitions, shared between enqueuer (API) and
 *     consumer (worker).
 *   - Connection factory that returns an ioredis client from REDIS_URL.
 *
 * BullMQ is not wrapped: the API and worker build their own `Queue` / `Worker`
 * instances from these names and types.
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
  /**
   * Campaign async jobs. One job per `campaign_job` row; the worker's
   * `campaign` role runs the channel handler and writes status back.
   */
  CampaignProcess: 'campaign-process',
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

/**
 * Campaign-process job. Carries only the `campaign_job` id; the worker loads
 * everything else from Postgres, so a retried job reads current data.
 */
export interface CampaignProcessJob {
  /** `campaign_job.id` — the durable job to process. */
  jobId: string;
}

// ─── Redis connection ────────────────────────────────────────────────────────

export interface RedisConnectionOptions {
  /** redis://host:port[/db] — full URL form. Defaults to REDIS_URL env. */
  url?: string;
  /**
   * Per-request retry cap. Defaults to `null`, which BullMQ requires. Non-queue
   * callers should set a finite value to fail fast when Redis is down.
   */
  maxRetriesPerRequest?: number | null;
  /**
   * Per-command timeout in ms. Leave unset for queue connections. Set it to
   * bound a single command when Redis is down.
   */
  commandTimeout?: number;
  /**
   * When `false`, commands sent while disconnected reject instead of
   * buffering. Fail-open callers should set it to `false`.
   */
  enableOfflineQueue?: boolean;
}

/**
 * Returns an ioredis instance. Defaults suit BullMQ (`maxRetriesPerRequest`
 * must be `null`); non-queue callers can override them to fail fast.
 *
 * The caller must call `.disconnect()` on shutdown.
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

/**
 * Job options for the `campaign-process` queue. Same retries as
 * {@link DEFAULT_JOB_OPTS}; the API may override `attempts` from
 * `CAMPAIGN_EXPORT_ATTEMPTS`. Not `as const`, so callers can override it.
 */
export const CAMPAIGN_PROCESS_JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 1000 },
  removeOnComplete: { age: 3600 },
  removeOnFail: { age: 604800 },
};

// ─── Bulk-upload Redis key namespace ─────────────────────────────────────────

/**
 * Every per-upload Redis key under `bu:{uploadId}:*`. `:lines` and `:errors`
 * hold participant PII. Delete all of them on cleanup and terminal states.
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
