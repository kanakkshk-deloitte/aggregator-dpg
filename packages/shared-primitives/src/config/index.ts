/**
 * Config primitives shared by the api and worker processes.
 *
 * Holds config fields and checks that must be the same in both processes: the
 * SignalStack push fields, the TLS-posture guard, and the campaign export
 * field-set. Each process spreads them into its own `ConfigSchema`.
 *
 * @module @aggregator-dpg/shared-primitives/config
 */

import { z } from 'zod';
import { ConfigError } from '../errors/index.js';

/**
 * SignalStack push env fields shared by every process that pushes to SignalStack.
 * Process-specific fields such as `SIGNALSTACK_ACTING_ORG_ID` and
 * `KEYCLOAK_URL`/`KEYCLOAK_REALM` are declared by each process.
 */
export const signalStackConfigFields = {
  /** Base URL of the signalstack API. When unset, signalstack push is disabled. */
  SIGNALSTACK_BASE_URL: z.string().url().optional(),
  /** Admin api-key for signalstack onboard. Required when SIGNALSTACK_BASE_URL is set. */
  SIGNALSTACK_ADMIN_KEY: z.string().optional(),
  /** item_network sent on every onboard call. */
  SIGNALSTACK_ITEM_NETWORK: z.string().default('blue_dot'),
  /** Per-request timeout for signalstack onboard calls. */
  SIGNALSTACK_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  /**
   * Which credential `HttpSignalStackWriter` sends: `apikey` (default) uses the
   * `SIGNALSTACK_ADMIN_KEY` header; `bearer` fetches a Keycloak
   * client-credentials token. Must match across processes.
   */
  SIGNALSTACK_AUTH_MODE: z.enum(['apikey', 'bearer']).default('apikey'),
  /**
   * Confidential Keycloak client id for the bearer credential. Must equal this
   * aggregator's signals `organization.slug` (see `SIGNALSTACK_ORG_SLUG`).
   * Required when `SIGNALSTACK_AUTH_MODE=bearer`.
   */
  SIGNALSTACK_CLIENT_ID: z.string().optional(),
  /** Client secret for `SIGNALSTACK_CLIENT_ID`. Required when `SIGNALSTACK_AUTH_MODE=bearer`. */
  SIGNALSTACK_CLIENT_SECRET: z.string().optional(),
  /**
   * This aggregator's `organization.slug` on the signals side. When set, boot
   * asserts `SIGNALSTACK_CLIENT_ID` equals it. The check is skipped when
   * unset. Must match across processes.
   */
  SIGNALSTACK_ORG_SLUG: z.string().optional(),
  /**
   * Realm holding the signals service client, when it differs from the realm
   * this app authenticates its own users against (`KEYCLOAK_REALM`).
   *
   * Optional. Falls back to `KEYCLOAK_REALM`.
   */
  SIGNALSTACK_KEYCLOAK_REALM: z.string().optional(),
} as const;

/**
 * Campaign export field-set, shared by the api and worker processes.
 *
 * The worker reads `CAMPAIGN_EXPORT_FIELDS` to decide what an export releases.
 * The api reads it to record `pii_fields` on the `campaign_pii_audit` row.
 * Sharing the schema keeps validation and defaults the same.
 *
 * Each process still reads the env var on its own. Set it on both the api and
 * worker containers, or the audit log can record the wrong fields.
 */
export const campaignExportConfigFields = {
  /**
   * `contact` = name/email/phone only; `full` = the whole decrypted
   * item_state (variable columns). Default `contact`.
   */
  CAMPAIGN_EXPORT_FIELDS: z.enum(['contact', 'full']).default('contact'),
} as const;

/** Minimal shape `assertTlsPosture` reads — any process `Config` satisfies it. */
export interface TlsPostureConfig {
  NODE_TLS_REJECT_UNAUTHORIZED?: string | undefined;
  INSTANCE_ENV?: string | undefined;
  NODE_ENV: string;
}

/**
 * Rejects `NODE_TLS_REJECT_UNAUTHORIZED=0` in production and warns elsewhere.
 *
 * Uses `process.emitWarning`, not the app logger, to avoid an import cycle.
 *
 * @param c - Parsed runtime config.
 * @throws {ConfigError} When `NODE_TLS_REJECT_UNAUTHORIZED=0` in production.
 */
export function assertTlsPosture(c: TlsPostureConfig): void {
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

/** Minimal shape `assertSignalStackClientIdentity` reads. */
export interface SignalStackIdentityConfig {
  SIGNALSTACK_AUTH_MODE: 'apikey' | 'bearer';
  SIGNALSTACK_CLIENT_ID?: string | undefined;
  SIGNALSTACK_ORG_SLUG?: string | undefined;
}

/**
 * Fails hard at boot when the bearer service-auth credential cannot resolve to
 * the right Signals organisation.
 *
 * Signals picks the acting org from the client id, so `SIGNALSTACK_CLIENT_ID`
 * must equal `SIGNALSTACK_ORG_SLUG`. A mismatch would act as the wrong org.
 * The check is skipped when the slug or the client id is unset.
 *
 * @param c - Parsed runtime config.
 * @throws {ConfigError} When bearer mode is on and client id ≠ expected slug.
 */
export function assertSignalStackClientIdentity(c: SignalStackIdentityConfig): void {
  if (c.SIGNALSTACK_AUTH_MODE !== 'bearer') return;
  if (!c.SIGNALSTACK_CLIENT_ID) return;
  const expected = c.SIGNALSTACK_ORG_SLUG;
  if (expected && c.SIGNALSTACK_CLIENT_ID !== expected) {
    throw new ConfigError(
      `SIGNALSTACK_CLIENT_ID (${c.SIGNALSTACK_CLIENT_ID}) must equal SIGNALSTACK_ORG_SLUG ` +
        `(${expected}) — signals resolves the acting organisation from the client id, so a ` +
        'mismatch would act as the wrong org.',
      { code: 'SIGNALSTACK_CLIENT_ID_MISMATCH' },
    );
  }
}
