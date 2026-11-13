/**
 * Runtime configuration for the worker app, parsed from env at startup.
 *
 * Holds only the variables the worker uses.
 */

import { z } from 'zod';
import {
  assertSignalStackClientIdentity,
  assertTlsPosture,
  campaignExportConfigFields,
  signalStackConfigFields,
} from '@aggregator-dpg/shared-primitives/config';

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  /** Deployment environment; falls back to NODE_ENV when unset. */
  INSTANCE_ENV: z.enum(['development', 'staging', 'production']).optional(),
  /**
   * Read only so the startup guard can reject `0` in production. Node reads it
   * from process.env itself; do not derive TLS posture from this field elsewhere.
   * A plain string, since Node disables TLS checks only for the exact value `'0'`.
   */
  NODE_TLS_REJECT_UNAUTHORIZED: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /**
   * Postgres connection string. No default, since it holds credentials.
   * Startup fails when unset.
   */
  DATABASE_URL: z.string().min(1, 'DATABASE_URL must be set'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  /** Liveness endpoint port, see health.ts. */
  HEALTH_PORT: z.coerce.number().int().positive().default(8080),

  // ─── Object storage ─────────────────────────────────────────────────────
  S3_ENDPOINT: z.string().optional(),
  /**
   * Browser-reachable S3 host, used only to sign download URLs.
   * Falls back to `S3_ENDPOINT` when unset.
   */
  S3_PUBLIC_ENDPOINT: z.string().optional(),
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
   * TTL (seconds) for the per-upload Redis keys (`bu:{id}:*`), which hold PII.
   * Covers uploads that fail before the finaliser deletes the keys. Must exceed
   * the watchdog's 30 min stuck threshold. Default 24h.
   */
  BULK_UPLOAD_REDIS_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),

  // ─── Worker role selection ──────────────────────────────────────────────
  /**
   * Comma-separated roles this process runs: `file`, `row`, `finalise`, `cron`,
   * `campaign`. Unset, empty or `all` runs every role.
   */
  WORKER_ROLES: z.string().optional(),

  // ─── Worker concurrency ─────────────────────────────────────────────────
  BULK_FILE_PROCESS_CONCURRENCY: z.coerce.number().int().positive().default(2),
  BULK_ROW_PROCESS_CONCURRENCY: z.coerce.number().int().positive().default(10),
  // How many different uploads can finalise in parallel. jobId dedup allows
  // one finaliser per upload.
  BULK_FINALISE_CONCURRENCY: z.coerce.number().int().positive().default(2),

  // ─── Link metrics aggregator ────────────────────────────────────────────
  /** Cron interval (ms) for the link-metrics rollup tick. Default 1 min. */
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
  // Shared with the api via @aggregator-dpg/shared-primitives/config.
  ...signalStackConfigFields,
  /** Keycloak base URL, used only to get the Signals service token in bearer mode. */
  KEYCLOAK_URL: z.string().optional(),
  KEYCLOAK_REALM: z.string().optional(),

  // ─── Campaign PII export ────────────────────────────────────────────────
  /**
   * TTL (seconds) of the export download link. Default 1 day.
   * Keep in step with the S3 lifecycle rule that deletes the file
   * (bluedots-automation `global.campaignExportExpiryDays`).
   */
  EXPORT_URL_TTL_SECONDS: z.coerce.number().int().positive().default(86400),
  /** Campaign jobs run in parallel by this process, across all channels. Default 2. */
  CAMPAIGN_CONCURRENCY: z.coerce.number().int().positive().default(2),
  /** How many recipients a single email-channel campaign job sends in parallel. Default 5. */
  EMAIL_SEND_CONCURRENCY: z.coerce.number().int().positive().default(5),
  /** Items per Signals decrypt request. The heartbeat is bumped per chunk. */
  CAMPAIGN_DECRYPT_CHUNK: z.coerce.number().int().positive().default(500),
  // Shared with the api, which records the same field set in the audit row.
  ...campaignExportConfigFields,
  /**
   * Who receives the export link: `requester` (default, the job's `requested_by`)
   * or `network_admin` (`EXPORT_NETWORK_ADMIN_EMAIL`).
   */
  CAMPAIGN_EXPORT_RECIPIENT: z.enum(['requester', 'network_admin']).default('requester'),
  /** Recipient used when CAMPAIGN_EXPORT_RECIPIENT=network_admin. */
  EXPORT_NETWORK_ADMIN_EMAIL: z.string().optional(),
  /**
   * A campaign job whose `last_progress_at` is older than this (seconds) is
   * treated as stalled by the watchdog and failed. Default 900 (15 min).
   */
  CAMPAIGN_STALL_SECONDS: z.coerce.number().int().positive().default(900),

  // ─── Campaign voice channel ────────────────────────────────────────────
  /** Voice campaign provider (currently only `raya` is supported). */
  CAMPAIGN_VOICE_PROVIDER: z.enum(['raya']).default('raya'),
  /** Raya API base URL. */
  RAYA_BASE_URL: z.string().url().default('https://v1.getraya.app/api'),
  /** Raya API key. Checked when the voice provider is first used. */
  RAYA_API_KEY: z.string().min(1).optional(),
  /** HTTP timeout for Raya API calls (milliseconds). */
  RAYA_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  /** Rate-limit window for Raya outbound calls (seconds). */
  RAYA_EGRESS_WINDOW_SECONDS: z.coerce.number().int().positive().default(20),
  /** Max Raya calls allowed per window. */
  RAYA_EGRESS_MAX: z.coerce.number().int().positive().default(1),
});

export type Config = z.infer<typeof ConfigSchema>;

export const config: Config = ConfigSchema.parse(process.env);
assertTlsPosture(config);
assertSignalStackClientIdentity(config);
