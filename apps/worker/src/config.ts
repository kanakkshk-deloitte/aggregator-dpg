/**
 * Runtime configuration for the worker process. Mirrors the shape of the
 * API config but only loads the variables the worker actually consumes.
 */

import { z } from 'zod';
import { ConfigError } from '@aggregator-dpg/shared-primitives/errors';

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  /** Deployment environment; falls back to NODE_ENV when unset. */
  INSTANCE_ENV: z.enum(['development', 'staging', 'production']).optional(),
  /**
   * Observed ONLY so the startup guard can reject the insecure `0` value in
   * production. Node reads this directly from process.env for its TLS
   * behaviour — do not re-derive TLS posture from this field elsewhere. Kept
   * a free string (not an enum) because Node treats only the exact value `'0'`
   * as "disable"; any other value (empty, `'true'`, unset) leaves verification
   * on, and an enum would crash-parse those benign values.
   */
  NODE_TLS_REJECT_UNAUTHORIZED: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z
    .string()
    .default('postgres://aggregator:aggregator-dev@localhost:5433/aggregator'),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // ─── Object storage ─────────────────────────────────────────────────────
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('aggregator-bulk-uploads'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // ─── Schema loader ──────────────────────────────────────────────────────
  /** Absolute or relative path to `config/schemas/`. */
  SCHEMA_ROOT_DIR: z.string().default('./config/schemas'),

  // ─── File Processor limits ──────────────────────────────────────────────
  BULK_MAX_ROWS: z.coerce.number().int().positive().default(10000),
  BULK_MAX_ROW_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(64 * 1024),

  /**
   * TTL (seconds) applied to every per-upload Redis key (`bu:{id}:*`, which
   * includes the raw participant CSV in `:lines` and error rows in `:errors`).
   * A safety net so participant PII cannot persist indefinitely when an upload
   * fails or is abandoned before `bulk-finalise` deletes the keys. Must comfortably
   * exceed the longest expected processing time (the stuck-job watchdog kills
   * in-flight uploads after 30 min). Default 24h.
   */
  BULK_UPLOAD_REDIS_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),

  // ─── Worker role selection ──────────────────────────────────────────────
  /**
   * Comma-separated subset of consumer roles this process runs:
   * `file`, `row`, `finalise`, `cron`. Unset / empty / `all` runs everything
   * (single-process default). Run `file` in its own deployment to isolate the
   * CPU-sensitive parser from the other consumers.
   */
  WORKER_ROLES: z.string().optional(),

  // ─── Worker concurrency ─────────────────────────────────────────────────
  BULK_FILE_PROCESS_CONCURRENCY: z.coerce.number().int().positive().default(2),
  BULK_ROW_PROCESS_CONCURRENCY: z.coerce.number().int().positive().default(10),
  // Concurrency caps how many DIFFERENT uploads can finalise in parallel
  // across the worker process. BullMQ jobId dedupe (`${uploadId}:finalise`)
  // already guarantees one finaliser per upload.
  BULK_FINALISE_CONCURRENCY: z.coerce.number().int().positive().default(2),

  // ─── Link metrics aggregator ────────────────────────────────────────────
  /**
   * Cron interval (ms) for the link-metrics rollup tick. Default 1 min so
   * public-form submissions surface on the aggregator dashboard quickly.
   * Override via env for higher-throughput deployments where 1 min creates
   * too much DB churn.
   */
  LINK_METRICS_ROLLUP_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 1000),

  // ─── Watchdog cron ──────────────────────────────────────────────────────
  /** Cron interval (ms) for the stuck-job watchdog tick. Default 1 hour. */
  WATCHDOG_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 1000),

  // ─── SignalStack outward push ───────────────────────────────────────────
  /** Base URL of the signalstack API. When unset, signalstack push is disabled. */
  SIGNALSTACK_BASE_URL: z.string().url().optional(),
  /** Admin api-key for signalstack onboard. Required when SIGNALSTACK_BASE_URL is set. */
  SIGNALSTACK_ADMIN_KEY: z.string().optional(),
  /** item_network sent on every onboard call. */
  SIGNALSTACK_ITEM_NETWORK: z.string().default('blue_dot'),
  /** Per-request timeout for signalstack onboard calls. */
  SIGNALSTACK_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Fails hard (per designs/_DECISIONS.md D7) when TLS certificate verification
 * is disabled under a production environment; warns loudly in dev/staging so
 * the relaxation is never silent. This is the enforcement that makes the
 * insecure posture impossible in prod — the compose default flip alone is not
 * enough, because an operator can still export the var globally.
 *
 * Uses `process.emitWarning` (not the app logger) for the non-fatal path to
 * avoid a config↔logger circular import (logger.ts imports this module).
 *
 * @param c - Parsed runtime config.
 * @throws {ConfigError} When NODE_TLS_REJECT_UNAUTHORIZED=0 in production.
 */
export function assertTlsPosture(c: Config): void {
  // Node disables verification only for the exact string '0'.
  if (c.NODE_TLS_REJECT_UNAUTHORIZED !== '0') return;
  const env = c.INSTANCE_ENV ?? c.NODE_ENV;
  const msg = 'NODE_TLS_REJECT_UNAUTHORIZED=0 disables all TLS certificate verification';
  if (env === 'production') {
    throw new ConfigError(`${msg}; refusing to start in production.`, {
      code: 'INSECURE_TLS_IN_PROD',
    });
  }
  process.emitWarning(
    `${msg}. Allowed outside production (env=${env}); never use this on a VM/prod deploy.`,
    { code: 'INSECURE_TLS_POSTURE' },
  );
}

export const config: Config = ConfigSchema.parse(process.env);
assertTlsPosture(config);
