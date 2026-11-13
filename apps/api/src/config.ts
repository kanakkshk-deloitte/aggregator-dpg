/**
 * Runtime configuration for the api app, loaded from environment variables.
 *
 * Values are read once at module load. Defaults target the local-dev compose
 * stack; deployments override them through the environment.
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
   * from process.env itself; do not re-derive TLS posture from this field
   * elsewhere. A free string, because only the exact value `'0'` disables
   * verification.
   */
  NODE_TLS_REJECT_UNAUTHORIZED: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Comma-separated allowed CORS origins. Use `*` only in dev. */
  CORS_ORIGINS: z.string().default('http://localhost:3000,http://localhost:3100'),
  /** Postgres connection string. No default because it carries credentials; startup fails when unset. */
  DATABASE_URL: z.string().min(1, 'DATABASE_URL must be set'),
  /** Run pending DB migrations on startup. Disable in CI/test to avoid races. */
  RUN_MIGRATIONS_ON_BOOT: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /**
   * Serve the OpenAPI spec and Scalar UI at /api/reference. Ignored in
   * production unless API_REFERENCE_FORCE is set (see {@link apiReferenceEnabled}).
   */
  API_REFERENCE_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** Serve the API reference even in production. Off by default. */
  API_REFERENCE_FORCE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Public origin of the API; used in admin email links and as the OpenAPI `servers[0].url`. */
  PUBLIC_API_URL: z.string().default('http://localhost:4000'),
  /** Public origin of the portal (BFF web app); used in welcome emails. */
  PUBLIC_PORTAL_URL: z.string().default('http://localhost:3000'),
  /** Comma-separated list of admin recipient email addresses. */
  ADMIN_EMAILS: z.string().default(''),
  /**
   * Optional owner of the Default org. When set, boot makes this account the
   * Default org's owner and its coordinator reviews go here; otherwise to `ADMIN_EMAILS`.
   */
  DEFAULT_ORG_OWNER_EMAIL: z
    .string()
    .trim()
    .transform((v) => v.toLowerCase())
    .pipe(z.union([z.literal(''), z.string().email()]))
    .default(''),
  /**
   * Per-domain Signals UI login URLs, as comma-separated `domain=url` pairs:
   *
   *   SIGNALS_UI_URLS=seeker=https://signals-seeker.example/auth/login,provider=https://...
   *
   * Each network domain has its own Signals UI. Unset means the public form
   * shows no Signals hand-off.
   *
   * Use the Signals UI URL (normally `<origin>/auth/login`), never a Keycloak
   * authorization URL: those carry one-time PKCE/state values and fail for other users.
   */
  SIGNALS_UI_URLS: z.string().default(''),
  /**
   * Comma-separated onboarding capabilities offered when creating a registration
   * link. Values are the network's `registration_modes` keys (`form`, `voice`);
   * `bulk` is reserved and gates nothing yet.
   *
   * Unset enables every capability. Set but blank enables none and logs a
   * warning, so this is `.optional()`, not `.default('')`. Deploy config must
   * omit the key when unconfigured.
   *
   * An env var, not YAML, so it can differ per instance.
   *
   * Gates link creation only; existing links keep working in their own mode,
   * which is why `routes/public-registration-links.ts` reads the unfiltered
   * network config.
   */
  AGGREGATOR_ONBOARDING_ENABLED: z.string().optional(),
  /**
   * Comma-separated recipients for contact-support submissions.
   * Unset means the endpoint returns 503 and the web button is hidden.
   */
  SUPPORT_EMAIL: z.string().optional(),
  /** Optional comma-separated CC recipients for contact-support submissions. */
  SUPPORT_CC_EMAIL: z.string().optional(),
  /**
   * Contact-support attachment limits: total decoded bytes and file count per submission.
   * Served to the web form by `GET /v1/support/config`. SES caps a message at
   * 10MB after base64, so about 7MB of files is the real ceiling.
   */
  SUPPORT_ATTACHMENT_MAX_TOTAL_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 1024 * 1024),
  SUPPORT_ATTACHMENT_MAX_FILES: z.coerce.number().int().positive().default(3),

  // ─── Object storage (bulk uploads + errors.csv) ──────────────────────────
  /** S3-compatible endpoint URL (MinIO in dev). Leave blank for AWS S3. */
  S3_ENDPOINT: z.string().optional(),
  /** Browser-reachable endpoint for pre-signed URLs. Falls back to S3_ENDPOINT. */
  S3_PUBLIC_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  /** Bucket holding uploaded CSVs and generated error reports. */
  S3_BUCKET: z.string().default('aggregator-bulk-uploads'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  /** Force path-style addressing (`endpoint/bucket`). Required for MinIO. */
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
   * Base URL of the public registration-link page. A link is
   * `${PUBLIC_LINK_BASE_URL}/${org_slug}/${slug}`; the QR encodes it.
   */
  PUBLIC_LINK_BASE_URL: z.string().default('http://localhost:3000'),
  // ─── Campaign export channel ────────────────────────────────────────────
  /** Max `item_ids` accepted per export request body (after de-dup). */
  CAMPAIGN_EXPORT_MAX_ITEMS: z.coerce.number().int().positive().default(500),
  /** Ingress rate-limit window (seconds) for export submits, per org. */
  CAMPAIGN_EXPORT_SUBMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  /** Max export submits allowed per window, per org. */
  CAMPAIGN_EXPORT_SUBMIT_MAX: z.coerce.number().int().positive().default(10),
  /** Max active (queued|processing) export jobs allowed per org at once. */
  CAMPAIGN_EXPORT_MAX_ACTIVE_PER_ORG: z.coerce.number().int().positive().default(3),
  /** BullMQ attempts for an export campaign-process job (retry count on transient failure). */
  CAMPAIGN_EXPORT_ATTEMPTS: z.coerce.number().int().positive().default(3),
  // Shared with the worker. The API reads it only to record audit `piiFields`.
  ...campaignExportConfigFields,

  // ─── Campaign voice channel ─────────────────────────────────────────────
  /** Max `participant_ids` accepted per voice campaign request body (after de-dup). */
  CAMPAIGN_VOICE_MAX_ITEMS: z.coerce.number().int().positive().default(500),
  /** Ingress rate-limit window (seconds) for voice campaign submits, per org. */
  CAMPAIGN_VOICE_SUBMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  /** Max voice campaign submits allowed per window, per org. */
  CAMPAIGN_VOICE_SUBMIT_MAX: z.coerce.number().int().positive().default(10),
  /** Max active (queued|processing) voice campaign jobs allowed per org at once. */
  CAMPAIGN_VOICE_MAX_ACTIVE_PER_ORG: z.coerce.number().int().positive().default(3),
  /** BullMQ attempts for a voice campaign job (retry count on transient failure). */
  CAMPAIGN_VOICE_ATTEMPTS: z.coerce.number().int().positive().default(3),
  // ─── Campaign email channel ─────────────────────────────────────────────
  /** Max `item_ids` (recipients) accepted per email request body (after de-dup). */
  CAMPAIGN_EMAIL_MAX_ITEMS: z.coerce.number().int().positive().default(200),
  /** Ingress rate-limit window (seconds) for email submits, per org. */
  CAMPAIGN_EMAIL_SUBMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  /** Max email submits allowed per window, per org. */
  CAMPAIGN_EMAIL_SUBMIT_MAX: z.coerce.number().int().positive().default(10),
  /** Max active (queued|processing) email jobs allowed per org at once. */
  CAMPAIGN_EMAIL_MAX_ACTIVE_PER_ORG: z.coerce.number().int().positive().default(3),
  /** BullMQ attempts for an email job. Retries never re-send an item already marked `sent`. */
  CAMPAIGN_EMAIL_ATTEMPTS: z.coerce.number().int().positive().default(3),

  // ─── Approval links ───────────────────────────────────────────────────────
  /**
   * Lifetime in seconds of emailed approval links. Sets both the token expiry
   * and the "expires in" text. Default 7 days.
   */
  APPROVAL_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(7 * 24 * 60 * 60),

  /** Coordinator-invite token lifetime. Default 14 days. */
  INVITE_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(14 * 24 * 60 * 60),

  /** Org-owner grant-token lifetime. Default 90 days. */
  GRANT_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(90 * 24 * 60 * 60),

  // Per-actor limit on console decisions and edits. Fails open.
  CONSOLE_WRITE_RATE_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  CONSOLE_WRITE_RATE_MAX_PER_WINDOW: z.coerce.number().int().positive().default(60),
  /** Max recipients per mint request. Default 10. */
  INVITE_MINT_MAX_RECIPIENTS: z.coerce.number().int().positive().default(10),

  /**
   * Window and cap for re-sending an approved org's link when its owner
   * re-submits the form. Keyed on the stored owner email (not the client IP)
   * and fails closed even when Redis is down, because every admitted call mints
   * another 90-day link.
   */
  ORG_INVITE_RESEND_RATE_WINDOW_SECONDS: z.coerce.number().int().positive().default(3600),
  ORG_INVITE_RESEND_RATE_MAX_PER_WINDOW: z.coerce.number().int().positive().default(3),

  /**
   * Extra grace beyond the approval-token TTL before a still-pending
   * registration is eligible for cleanup. Default 24h.
   */
  REGISTRATION_PENDING_GRACE_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(24 * 60 * 60 * 1000),

  /** Minutes after a rejection before the same owner or coordinator may re-register. Default 720 (12h). */
  REGISTRATION_COOLING_MINUTES: z.coerce.number().int().positive().default(720),

  // ─── Schema loader ──────────────────────────────────────────────────────
  /** Absolute or relative path to `config/schemas/`. Used by link-submit Ajv. */
  SCHEMA_ROOT_DIR: z.string().default('./config/schemas'),

  // ─── Rate limit (public link submit) ────────────────────────────────────
  PUBLIC_SUBMIT_RATE_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  PUBLIC_SUBMIT_RATE_MAX_PER_WINDOW: z.coerce.number().int().positive().default(20),

  /**
   * Proxies allowed to set `X-Forwarded-For`, which decides `req.ip` for the rate limiter.
   * Comma-separated IPs, CIDRs or Fastify groups. Production must set the BFF
   * subnet. The default trusts private ranges only.
   */
  TRUST_PROXY: z.string().default('loopback,linklocal,uniquelocal'),

  // ─── SignalStack outward push ───────────────────────────────────────────
  // Shared with the worker; the acting org id below is api-only.
  ...signalStackConfigFields,
  /**
   * Signals org id sent as `x-acting-org-id` for admin upserts. Required when
   * SIGNALSTACK_BASE_URL is set, so approval can register the aggregator in Signals.
   */
  SIGNALSTACK_ACTING_ORG_ID: z.string().optional(),
  // ─── RBAC (docs/rbac/rbac-design-aggregator.md) ─────────────────────────
  /**
   * The one RBAC switch, for the API and its edge (Envoy + OPA in front of it,
   * docs/rbac/rbac-edge-enforcement.md). `off`: nothing is loaded, no check
   * runs, nothing is published to the edge (deploy no edge). `log`: the API
   * publishes its role catalogue to OPA and keeps the token `roles` claim in
   * step; the edge records what it would refuse and the API's per-organisation
   * checks log a would-deny, but nothing is refused. `enforce`: the edge
   * refuses a missing route permission (403) and the API's per-organisation
   * checks refuse. The API itself no longer checks route permissions, so an
   * instance with `enforce` must run the edge in front of it.
   */
  RBAC_MODE: z.enum(['off', 'log', 'enforce']).default('off'),
  /**
   * Enables custom-role authoring by the network admin. When false (default),
   * only built-in roles load, custom-role assignments grant nothing, and the
   * authoring routes are not registered. No effect when `RBAC_MODE=off`.
   * Only the edge limits the authoring routes to the network admin, so an
   * instance that turns this on must run the edge (decision E8,
   * docs/rbac/rbac-edge-enforcement.md).
   */
  RBAC_CUSTOM_ROLES_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Base URL of the OPA sidecar. Validated at boot. */
  OPA_URL: z.string().url().default('http://localhost:8181'),
  /** Per-attempt timeout for an OPA decision. */
  OPA_TIMEOUT_MS: z.coerce.number().int().positive().default(500),
  /** Retries after the first OPA attempt, for transient failures. */
  OPA_RETRIES: z.coerce.number().int().min(0).max(3).default(1),
  /** Base backoff between OPA retries; doubles per retry. */
  OPA_BACKOFF_MS: z.coerce.number().int().positive().default(50),
  /** How often each replica checks the RBAC catalogue version and reloads on change. `0` disables it. */
  RBAC_CATALOGUE_REFRESH_MS: z.coerce.number().int().min(0).default(30000),
  /**
   * With RBAC on: how often the API retries failed `roles`-claim writes and
   * re-syncs users whose timed role expired (`0` disables). A role that expired
   * stays in the claim until this sweep plus the user's next token refresh.
   */
  RBAC_TOKEN_ROLES_SWEEP_MS: z.coerce.number().int().min(0).default(60_000),
  /**
   * With RBAC on: how often every user's `roles` claim is rewritten from the
   * database to repair drift (`0` disables). It also runs once at boot.
   */
  RBAC_TOKEN_ROLES_RECONCILE_MS: z.coerce.number().int().min(0).default(86_400_000),
});

export type Config = z.infer<typeof ConfigSchema>;

export const config: Config = ConfigSchema.parse(process.env);
assertTlsPosture(config);
assertSignalStackClientIdentity(config);

export const corsOrigins: string[] = config.CORS_ORIGINS.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * The configured owner of the Default org, or `null`.
 *
 * Read from the environment at call time, so tests can change it.
 *
 * @returns The lowercased email, or `null` when unset or blank.
 */
export function defaultOrgOwnerEmail(): string | null {
  return process.env.DEFAULT_ORG_OWNER_EMAIL?.trim().toLowerCase() || null;
}

/**
 * Recipient address for contact-support submissions.
 *
 * Read from the environment at call time, so tests can change it.
 *
 * @returns The recipients joined with `, `, or `undefined` when unset (support is then disabled).
 */
export function supportEmail(): string | undefined {
  return normaliseEmailList(process.env.SUPPORT_EMAIL);
}

/**
 * `azp` client ids allowed on the campaign routes.
 *
 * Replaces `KEYCLOAK_ALLOWED_AZP` on those routes, so they accept only these clients.
 * The global list leaves them out, so their tokens are refused on every other route.
 *
 * @returns The allowed `azp` values; default `['campaign-manager']`.
 */
export function campaignManagerAllowedAzp(): string[] {
  const raw = process.env.CAMPAIGN_MANAGER_ALLOWED_AZP?.trim() || 'campaign-manager';
  const parsed = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  // Never return an empty list: `[]` turns the azp check off.
  return parsed.length > 0 ? parsed : ['campaign-manager'];
}

/**
 * CC recipient(s) for contact-support submissions.
 *
 * Read from the environment at call time.
 *
 * @returns The CC list joined with `, `, or `undefined` when unset.
 */
export function supportCc(): string | undefined {
  return normaliseEmailList(process.env.SUPPORT_CC_EMAIL);
}

/**
 * Portal URL shown in the support email, so staff know which instance it came from.
 *
 * @returns The configured portal URL.
 */
export function supportPortalLink(): string {
  return config.PUBLIC_PORTAL_URL;
}

/**
 * Attachment limits for the contact-support form.
 *
 * Read from the environment at call time.
 *
 * @returns Max total decoded bytes and file count; 5MB and 3 when unset or invalid.
 */
export function supportAttachmentLimits(): { maxTotalBytes: number; maxFiles: number } {
  const parsed = z
    .object({
      SUPPORT_ATTACHMENT_MAX_TOTAL_BYTES: z.coerce
        .number()
        .int()
        .positive()
        .catch(5 * 1024 * 1024)
        .default(5 * 1024 * 1024),
      SUPPORT_ATTACHMENT_MAX_FILES: z.coerce.number().int().positive().catch(3).default(3),
    })
    .parse({
      SUPPORT_ATTACHMENT_MAX_TOTAL_BYTES: process.env.SUPPORT_ATTACHMENT_MAX_TOTAL_BYTES,
      SUPPORT_ATTACHMENT_MAX_FILES: process.env.SUPPORT_ATTACHMENT_MAX_FILES,
    });
  return {
    maxTotalBytes: parsed.SUPPORT_ATTACHMENT_MAX_TOTAL_BYTES,
    maxFiles: parsed.SUPPORT_ATTACHMENT_MAX_FILES,
  };
}

/**
 * Normalises a comma-separated email env value: trims entries, drops empties, joins with `, `.
 *
 * @param raw - The raw env value (or `undefined`).
 * @returns The joined list, or `undefined` when nothing remains.
 */
function normaliseEmailList(raw: string | undefined): string | undefined {
  const list = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list.join(', ') : undefined;
}

/**
 * Whether to serve the OpenAPI spec and Scalar UI.
 *
 * Off in production unless `API_REFERENCE_FORCE` is set.
 */
export const apiReferenceEnabled: boolean =
  config.API_REFERENCE_ENABLED && (config.NODE_ENV !== 'production' || config.API_REFERENCE_FORCE);

/**
 * Parses an email list env value (commas or newlines; tolerates Helm quoting and whitespace).
 */
function parseEnvEmailList(raw: string | undefined): string[] {
  return stripHelmQuoting(raw ?? '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export const adminEmails: string[] = parseEnvEmailList(config.ADMIN_EMAILS);

/**
 * Result of parsing `SIGNALS_UI_URLS`: the `{ domain: url }` map and one warning per skipped entry.
 *
 * Warnings are returned, not logged, because `logger.ts` imports this module;
 * `app.ts` logs them.
 */
export interface ParsedSignalsUiUrls {
  urls: Record<string, string>;
  warnings: string[];
}

/**
 * Strips one layer of Helm-style quotes and surrounding whitespace from an env value.
 *
 * @param raw - The raw string that may be quote-wrapped by Helm templating.
 * @returns The unwrapped, trimmed string.
 */
function stripHelmQuoting(raw: string): string {
  const v = raw.trim();
  if (
    v.length >= 2 &&
    ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
  ) {
    return v.slice(1, -1).trim();
  }
  return v;
}

/** The outcome of parsing one `domain=url` entry from `SIGNALS_UI_URLS`. */
type SignalsUiUrlEntryResult =
  { ok: true; domain: string; url: string } | { ok: false; warning: string };

/**
 * Parses and validates a single `domain=url` entry from `SIGNALS_UI_URLS`.
 *
 * @param pair - One trimmed, non-empty `domain=url` entry.
 * @returns The parsed `{ domain, url }`, or a warning when the entry is malformed.
 */
function parseSignalsUiUrlEntry(pair: string): SignalsUiUrlEntryResult {
  // First `=` only — URLs carry `=` inside query strings.
  const eq = pair.indexOf('=');
  if (eq === -1) {
    return {
      ok: false,
      warning: `SIGNALS_UI_URLS: skipping entry with no "=" separator: "${pair}"`,
    };
  }
  const domain = pair.slice(0, eq).trim();
  const url = pair.slice(eq + 1).trim();
  if (!/^[a-z][a-z0-9_]*$/.test(domain)) {
    return {
      ok: false,
      warning: `SIGNALS_UI_URLS: skipping entry with invalid domain key: "${pair}"`,
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      ok: false,
      warning: `SIGNALS_UI_URLS: skipping domain "${domain}" — value is not a valid URL`,
    };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      warning: `SIGNALS_UI_URLS: skipping domain "${domain}" — only http(s) URLs are allowed`,
    };
  }
  return { ok: true, domain, url };
}

/**
 * Parses the `SIGNALS_UI_URLS` env value into a `{ domain: url }` map.
 *
 * A malformed entry is skipped with a warning; boot does not fail. For a
 * duplicate domain the last entry wins, with a warning.
 *
 * Domain keys are checked for format only. The check against the network's
 * domains is {@link unknownSignalsUiUrlDomains}.
 *
 * @param raw - The raw env value.
 * @returns The parsed map and warnings.
 */
export function parseSignalsUiUrls(raw: string | undefined): ParsedSignalsUiUrls {
  const v = stripHelmQuoting(raw ?? '');
  const urls: Record<string, string> = {};
  const warnings: string[] = [];
  for (const entry of v.split(/[,\n]/)) {
    const pair = entry.trim();
    if (!pair) continue;
    const result = parseSignalsUiUrlEntry(pair);
    if (!result.ok) {
      warnings.push(result.warning);
      continue;
    }
    if (Object.hasOwn(urls, result.domain)) {
      warnings.push(
        `SIGNALS_UI_URLS: duplicate entry for domain "${result.domain}" — the last one wins`,
      );
    }
    urls[result.domain] = result.url;
  }
  return { urls, warnings };
}

/**
 * Which parsed `SIGNALS_UI_URLS` keys name no domain this network declares.
 *
 * Runs once the network config resolves. The caller only logs the result;
 * the map is used unchanged.
 *
 * @param urls - The parsed `{ domain: url }` map.
 * @param knownDomains - `ResolvedNetworkConfig.domainIds`.
 * @returns The unrecognised keys, in insertion order; empty when all match.
 */
export function unknownSignalsUiUrlDomains(
  urls: Readonly<Record<string, string>>,
  knownDomains: readonly string[],
): string[] {
  const known = new Set(knownDomains);
  return Object.keys(urls).filter((domain) => !known.has(domain));
}

const parsedSignalsUiUrls = parseSignalsUiUrls(config.SIGNALS_UI_URLS);

/**
 * Per-domain Signals UI login URLs, parsed once at boot. Empty when unset.
 *
 * Frozen because every value is a checked http(s) URL that the web app puts in an `href`.
 */
export const signalsUiUrls: Readonly<Record<string, string>> = Object.freeze(
  parsedSignalsUiUrls.urls,
);

/**
 * Warnings from parsing `SIGNALS_UI_URLS`; `app.ts` logs them.
 */
export const signalsUiUrlWarnings: string[] = parsedSignalsUiUrls.warnings;

/**
 * Result of parsing `AGGREGATOR_ONBOARDING_ENABLED`. Warnings are logged by `app.ts`.
 */
export interface ParsedOnboardingEnabled {
  /**
   * Allowed capability keys. `null` when the var is unset (everything enabled);
   * `[]` when it is set but names nothing (nothing enabled).
   */
  capabilities: string[] | null;
  warnings: string[];
}

/**
 * Capability keys the allow-list accepts but which gate nothing yet.
 *
 * Not reported as unknown by {@link unknownOnboardingCapabilities}. Listing
 * only reserved keys still disables all onboarding.
 */
export const RESERVED_ONBOARDING_CAPABILITIES: ReadonlySet<string> = new Set(['bulk']);

/**
 * Parses the `AGGREGATOR_ONBOARDING_ENABLED` allow-list.
 *
 * Trims and lowercases entries, splits on commas and whitespace, drops
 * empties and duplicates, and tolerates Helm quoting.
 *
 * Only an unset var enables everything. A set but blank var enables nothing
 * and adds a warning.
 *
 * Values are not checked against the network's modes here; see
 * {@link unknownOnboardingCapabilities}.
 *
 * @param raw - The raw env value (or `undefined` when unset).
 * @returns The capability list (`null` means all enabled) and warnings.
 */
export function parseOnboardingEnabled(raw: string | undefined): ParsedOnboardingEnabled {
  if (raw === undefined) return { capabilities: null, warnings: [] };
  const v = stripHelmQuoting(raw);
  const capabilities: string[] = [];
  const warnings: string[] = [];
  // Whitespace also separates, so `form voice` means two capabilities.
  for (const entry of v.split(/[\s,]+/)) {
    const key = entry.trim().toLowerCase();
    if (!key) continue;
    if (capabilities.includes(key)) {
      warnings.push(
        `AGGREGATOR_ONBOARDING_ENABLED: duplicate entry "${key}" — listing it once is enough`,
      );
      continue;
    }
    capabilities.push(key);
  }
  if (capabilities.length === 0) {
    // Set but names nothing: treated as nothing enabled.
    warnings.push(
      v === ''
        ? 'AGGREGATOR_ONBOARDING_ENABLED is set but blank — it names no capability, so no registration mode will be offered. Remove the variable entirely (not just its value) to enable all of them.'
        : 'AGGREGATOR_ONBOARDING_ENABLED is set but names no capability — no registration mode will be offered. Unset the variable to enable all of them.',
    );
  }
  return { capabilities, warnings };
}

/**
 * The onboarding capabilities this deployment offers, or `null` for "all".
 *
 * Read from the environment at call time.
 *
 * @returns The allowed capability keys, or `null` when unset.
 */
export function onboardingEnabledCapabilities(): readonly string[] | null {
  return parseOnboardingEnabled(process.env.AGGREGATOR_ONBOARDING_ENABLED).capabilities;
}

/**
 * Whether one onboarding capability is enabled for this deployment.
 *
 * Used by `GET /v1/aggregator-config` and by create-link validation.
 *
 * @param capability - A capability / registration-mode key, e.g. `voice`.
 * @returns `true` when the allow-list is unset or contains the key.
 */
export function isOnboardingCapabilityEnabled(capability: string): boolean {
  const enabled = onboardingEnabledCapabilities();
  return enabled === null || enabled.includes(capability);
}

/**
 * The declared registration modes this deployment actually offers.
 *
 * Shared by the boot diagnostics, `GET /v1/aggregator-config` and create-link
 * validation, so they always agree.
 *
 * @param declared - The network's declared `registration_modes` keys.
 * @returns The permitted subset, in declared order.
 */
export function enabledRegistrationModes(declared: readonly string[]): string[] {
  return declared.filter((mode) => isOnboardingCapabilityEnabled(mode));
}

/**
 * Which allow-listed capabilities are reserved keys that gate nothing yet.
 *
 * Reported separately from {@link unknownOnboardingCapabilities}, since these are accepted values.
 *
 * @param capabilities - The parsed allow-list (`null` means all enabled).
 * @returns The reserved values in listed order; empty when unset.
 */
export function reservedOnboardingCapabilities(capabilities: readonly string[] | null): string[] {
  if (capabilities === null) return [];
  return capabilities.filter((capability) => RESERVED_ONBOARDING_CAPABILITIES.has(capability));
}

/**
 * Which allow-listed capabilities name no registration mode this network
 * declares.
 *
 * Runs once the network config resolves. The caller only logs the result.
 * Reserved keys are excluded; see {@link reservedOnboardingCapabilities}.
 *
 * @param capabilities - The parsed allow-list (`null` means all enabled).
 * @param declaredModes - The network's declared `registration_modes` keys.
 * @returns The unrecognised values in listed order; empty when unset.
 */
export function unknownOnboardingCapabilities(
  capabilities: readonly string[] | null,
  declaredModes: readonly string[],
): string[] {
  if (capabilities === null) return [];
  const declared = new Set(declaredModes);
  return capabilities.filter(
    (capability) => !declared.has(capability) && !RESERVED_ONBOARDING_CAPABILITIES.has(capability),
  );
}

/**
 * Warnings from parsing `AGGREGATOR_ONBOARDING_ENABLED`; `app.ts` logs them.
 */
export const onboardingEnabledWarnings: string[] = parseOnboardingEnabled(
  config.AGGREGATOR_ONBOARDING_ENABLED,
).warnings;
