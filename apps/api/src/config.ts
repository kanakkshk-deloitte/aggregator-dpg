/**
 * Runtime configuration loaded from environment variables.
 *
 * All values are read once at module init so request handlers stay pure.
 * Defaults target the local-dev compose stack; production overrides come
 * from `.env` or the orchestration layer.
 */

import { z } from 'zod';

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /**
   * Comma-separated list of allowed CORS origins for the BFF and any future
   * direct browser clients. Use `*` only in dev.
   */
  CORS_ORIGINS: z.string().default('http://localhost:3000,http://localhost:3100'),
  /** Postgres connection string. Default points at the compose Postgres
   *  exposed on host port 5433 (5432 is left to system Postgres). */
  DATABASE_URL: z
    .string()
    .default('postgres://aggregator:aggregator-dev@localhost:5433/aggregator'),
  /** Run pending DB migrations on startup. Disable in CI/test to avoid races. */
  RUN_MIGRATIONS_ON_BOOT: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /**
   * Serve the OpenAPI spec + Scalar reference UI at /api/reference. The API
   * is internet-reachable, so the docs surface (including admin route paths)
   * is enumerable when enabled — defaults ON for dev convenience. This flag
   * is force-disabled under NODE_ENV=production (see {@link apiReferenceEnabled})
   * so a prod deploy never serves an enumerable route map by accident; opt back
   * in for prod only via API_REFERENCE_FORCE.
   */
  API_REFERENCE_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /**
   * Escape hatch to serve the docs surface even under NODE_ENV=production.
   * Off by default — must be explicitly set to expose the reference in prod.
   */
  API_REFERENCE_FORCE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /**
   * Enables the parent-org → coordinator hierarchy for this instance
   * (spec §2). OFF (default) = today's flat registration/approval flow,
   * unchanged: no org tab, no org dropdown, no `aggregator_orgs` rows,
   * `aggregators.parent_org_id` stays null. Read once at startup; flipping
   * requires a restart. Two instances of the same network can differ.
   */
  ORG_HIERARCHY_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Public origin of the API service; used to assemble admin email links. */
  PUBLIC_API_URL: z.string().default('http://localhost:4000'),
  /** Public origin of the portal (BFF web app); used in welcome emails. */
  PUBLIC_PORTAL_URL: z.string().default('http://localhost:3000'),
  /** Comma-separated list of admin recipient email addresses. */
  ADMIN_EMAILS: z.string().default(''),
  /** Recipient for contact-support submissions (#120-equivalent). Feature-gated: unset ⇒ endpoint 503, web button hidden. */
  SUPPORT_EMAIL: z.string().optional(),

  // ─── Object storage (bulk uploads + errors.csv) ──────────────────────────
  /**
   * S3-compatible endpoint URL. For MinIO in dev, set to
   * `http://minio:9000` (in-container) or `http://localhost:9000` (host).
   * For real S3, leave blank — the SDK uses AWS endpoints by region.
   */
  S3_ENDPOINT: z.string().optional(),
  /**
   * Browser-reachable endpoint used to mint pre-signed URLs. Falls back to
   * S3_ENDPOINT when unset (single-host dev). In production this is the
   * public hostname (e.g. https://s3.amazonaws.com or
   * https://files.example.com) while S3_ENDPOINT remains the in-cluster /
   * VPC-internal hostname for HEAD/PUT/GET ops.
   */
  S3_PUBLIC_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  /** Bucket holding uploaded CSVs and generated error reports. */
  S3_BUCKET: z.string().default('aggregator-bulk-uploads'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  /**
   * Force path-style addressing (bucket.endpoint.com vs endpoint.com/bucket).
   * Required for MinIO; auto-detected for AWS.
   */
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** Redis connection URL used by BullMQ queues. */
  REDIS_URL: z.string().default('redis://localhost:6379'),
  /** Pre-signed PUT URL TTL for bulk uploads (seconds). */
  BULK_UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  /** Maximum CSV file size for the pre-signed PUT (bytes). */
  BULK_UPLOAD_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024),

  // ─── Registration links ─────────────────────────────────────────────────
  /**
   * Base URL of the public landing page that resolves a registration link.
   * The public URL is `${PUBLIC_LINK_BASE_URL}/${org_slug}/${slug}`; the
   * aggregator's org_slug namespaces the per-link slug so two aggregators
   * may use the same slug. Encoded into the QR PNG.
   * Example: https://aggregator.example.com
   */
  PUBLIC_LINK_BASE_URL: z.string().default('http://localhost:3000'),
  /** Pre-signed GET URL TTL for QR PNG downloads (seconds). */
  QR_DOWNLOAD_URL_TTL_SECONDS: z.coerce.number().int().positive().default(900),

  // ─── Approval links ───────────────────────────────────────────────────────
  /**
   * Lifetime of the admin approval/rejection links emailed on a new
   * aggregator registration (seconds). Drives BOTH the signed-token expiry
   * and the human-readable "expires in …" wording on the admin email and the
   * confirmation page, so the two can never drift. Default: 7 days.
   */
  APPROVAL_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(7 * 24 * 60 * 60),

  /**
   * Extra grace beyond the approval-token TTL before a still-pending
   * registration is eligible for cleanup. Default 24h.
   */
  REGISTRATION_PENDING_GRACE_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(24 * 60 * 60 * 1000),

  // ─── Schema loader ──────────────────────────────────────────────────────
  /** Absolute or relative path to `config/schemas/`. Used by link-submit Ajv. */
  SCHEMA_ROOT_DIR: z.string().default('./config/schemas'),

  // ─── Rate limit (public link submit) ────────────────────────────────────
  PUBLIC_SUBMIT_RATE_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  PUBLIC_SUBMIT_RATE_MAX_PER_WINDOW: z.coerce.number().int().positive().default(20),

  /**
   * Trust-proxy configuration for Fastify. Controls which upstream addresses
   * are allowed to supply `X-Forwarded-For` (and therefore decide what
   * `req.ip` evaluates to — used by the public rate limiter).
   *
   * Accepts a comma-separated list of IPs, CIDR ranges, or Fastify named
   * groups (`loopback`, `linklocal`, `uniquelocal`). Production deployments
   * MUST set this to the BFF subnet so callers cannot spoof their source IP.
   * The default `loopback,linklocal,uniquelocal` trusts only RFC1918 private
   * ranges, which is safe behind a single-host Docker compose dev stack.
   */
  TRUST_PROXY: z.string().default('loopback,linklocal,uniquelocal'),

  // ─── SignalStack outward push ───────────────────────────────────────────
  /** Base URL of the signalstack API. When unset, signalstack push is disabled. */
  SIGNALSTACK_BASE_URL: z.string().url().optional(),
  /** Admin api-key for signalstack onboard. Required when SIGNALSTACK_BASE_URL is set. */
  SIGNALSTACK_ADMIN_KEY: z.string().optional(),
  /**
   * Platform-wide signalstack organisation id under which admin aggregator
   * upserts are performed (sent as `x-acting-org-id`). Required when
   * SIGNALSTACK_BASE_URL is set so the aggregator-approval flow can register
   * each newly-approved aggregator as a signalstack org.
   */
  SIGNALSTACK_ACTING_ORG_ID: z.string().optional(),
  /** item_network sent on every onboard call. */
  SIGNALSTACK_ITEM_NETWORK: z.string().default('blue_dot'),
  /** Per-request timeout for signalstack onboard calls. */
  SIGNALSTACK_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
});

export type Config = z.infer<typeof ConfigSchema>;

export const config: Config = ConfigSchema.parse(process.env);

export const corsOrigins: string[] = config.CORS_ORIGINS.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Whether the org→coordinator hierarchy is enabled for this instance.
 *
 * Read from the live environment at **call time** rather than from the frozen
 * `config` snapshot. It is consumed only on the startup path (route
 * registration inside `buildApp()`), so this still honours "read once at
 * startup" (configuration-discipline) while remaining deterministic under
 * Vitest's hoisted-import evaluation order, where a test sets the env var
 * before `buildApp()` runs but after `config` was first parsed.
 *
 * @returns `true` when `ORG_HIERARCHY_ENABLED` is the literal string `"true"`.
 */
export function orgHierarchyEnabled(): boolean {
  return process.env.ORG_HIERARCHY_ENABLED === 'true';
}

/**
 * Recipient address for contact-support submissions.
 *
 * Read from the live environment at **call time** rather than from the
 * frozen `config` snapshot — mirrors {@link orgHierarchyEnabled}. Unlike
 * that flag, this one is consumed on every request (`GET /v1/support/config`
 * and `POST /v1/support` both need the current value, not just a
 * startup-time snapshot), and it must be independently toggleable across
 * test cases (configured vs unset) within the same Vitest worker, where the
 * frozen `config.SUPPORT_EMAIL` reflects whatever env was present the first
 * time `config.ts` was imported and cannot be changed afterwards.
 *
 * @returns The configured support recipient, or `undefined` when
 *   `SUPPORT_EMAIL` is unset/empty (⇒ the support form reports disabled and
 *   `POST /v1/support` returns 503 `SUPPORT_NOT_CONFIGURED`).
 */
export function supportEmail(): string | undefined {
  return process.env.SUPPORT_EMAIL || undefined;
}

/**
 * Effective docs-surface switch used to gate the OpenAPI spec + Scalar UI.
 *
 * Secure-by-default on a public API: even when `API_REFERENCE_ENABLED` is on,
 * the enumerable route map is force-disabled under `NODE_ENV=production` unless
 * `API_REFERENCE_FORCE` is also set. Dev/staging keep it on for convenience.
 */
export const apiReferenceEnabled: boolean =
  config.API_REFERENCE_ENABLED && (config.NODE_ENV !== 'production' || config.API_REFERENCE_FORCE);

/**
 * Comma-separated ADMIN_EMAILS env value parsed into a clean list.
 * Resilient to wrapping quotes left in by Helm / ConfigMap `| quote`
 * filters, stray whitespace, and newline separators.
 */
function parseEnvEmailList(raw: string | undefined): string[] {
  let v = (raw ?? '').trim();
  if (
    v.length >= 2 &&
    ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
  ) {
    v = v.slice(1, -1).trim();
  }
  return v
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export const adminEmails: string[] = parseEnvEmailList(config.ADMIN_EMAILS);
