/**
 * Access-token verification.
 *
 * Validates the `Authorization: Bearer ...` header against the Keycloak
 * realm's JWKS, then projects a small claims subset into a strongly-typed
 * `AuthContext`. The route handlers use that context for authorisation —
 * never the raw token.
 */

import { jwtVerify, createRemoteJWKSet, type JWTPayload } from 'jose';
import type { FastifyRequest } from 'fastify';
import { getAggregatorStore } from '../aggregator-store/index.js';
import { getIdpAdmin } from '../idp-admin/index.js';
import { KC_ATTR } from '../idp-admin/attributes.js';
import { getSignalStackWriter } from '../signalstack.js';
import { getNetworkConfig } from '../network-config.js';
import { logger } from '../../logger.js';

let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let cachedJwksUrl: string | null = null;
let testOverride: ((token: string) => Promise<JWTPayload>) | null = null;

export type AggregatorType = string;

export interface AuthContext {
  /** Keycloak `sub` claim — stable user id. */
  userId: string;
  /** Custom claim mapped from the `aggregator_id` user attribute. */
  aggregatorId: string;
  /**
   * Custom claim mapped from the `aggregator_type` user attribute. Drives the
   * single-type enforcement on bulk uploads and public registration links —
   * the aggregator may only operate on the type it registered as.
   */
  aggregatorType?: AggregatorType;
  /**
   * Approval state read from the `decision_made` user-attribute claim.
   * `'pending'` when the admin has not yet decided. Auth-gated routes call
   * {@link requireApproved} to reject anything other than `'approved'`.
   */
  decisionMade?: 'pending' | 'approved' | 'rejected';
  /**
   * Signalstack organisation id read from the `signalstack_org_id`
   * user-attribute claim. Written at admin approval; backfilled by the
   * login-time fallback when missing. May be absent on the very first
   * authenticated request after an approval failure — handlers that need
   * it should call the fallback helper before proceeding.
   */
  signalstackOrgId?: string;
  email?: string;
  emailVerified?: boolean;
  preferredUsername?: string;
  firstName?: string;
  lastName?: string;
  phoneNumber?: string;
  phoneNumberVerified?: boolean;
}

export type AuthError =
  | { code: 'MISSING_TOKEN'; message: string }
  | { code: 'INVALID_TOKEN'; message: string }
  | { code: 'MISSING_AGGREGATOR_ID'; message: string }
  | { code: 'NOT_APPROVED'; message: string };

export type AuthResult = { ok: true; context: AuthContext } | { ok: false; error: AuthError };

export interface AnyAuthContext {
  /** `sub` claim. For service tokens this is the service-account user id. */
  subject: string;
  /** `azp` claim — the client that requested the token. */
  authorizedParty?: string;
  /** Token's `client_id` claim (Keycloak emits this on service-account tokens). */
  clientId?: string;
  /** Whether this token is bound to an end user (has `aggregator_id`). */
  isUser: boolean;
  aggregatorId?: string;
  email?: string;
}

export type AnyAuthResult =
  | { ok: true; context: AnyAuthContext }
  | {
      ok: false;
      error: { code: 'MISSING_TOKEN' | 'INVALID_TOKEN'; message: string };
    };

/**
 * Verifies the Bearer token on a Fastify request and returns an
 * `AuthContext`.
 */
export async function authenticate(req: FastifyRequest): Promise<AuthResult> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return { ok: false, error: { code: 'MISSING_TOKEN', message: 'missing Bearer token' } };
  }
  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    return { ok: false, error: { code: 'MISSING_TOKEN', message: 'empty Bearer token' } };
  }

  let payload: JWTPayload;
  try {
    payload = await verifyToken(token);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'INVALID_TOKEN',
        message: err instanceof Error ? err.message : 'verify failed',
      },
    };
  }

  if (!payload.sub) {
    return { ok: false, error: { code: 'INVALID_TOKEN', message: 'missing sub claim' } };
  }
  const aggregatorId = readAggregatorId(payload);
  if (!aggregatorId) {
    return {
      ok: false,
      error: {
        code: 'MISSING_AGGREGATOR_ID',
        message: 'token has no aggregator_id claim',
      },
    };
  }
  const ctx: AuthContext = {
    userId: payload.sub,
    aggregatorId,
  };
  const claims = payload as Record<string, unknown>;
  if (typeof claims.email === 'string') ctx.email = claims.email;
  if (typeof claims.email_verified === 'boolean') ctx.emailVerified = claims.email_verified;
  if (typeof claims.preferred_username === 'string') {
    ctx.preferredUsername = claims.preferred_username;
  }
  if (typeof claims.given_name === 'string') ctx.firstName = claims.given_name;
  if (typeof claims.family_name === 'string') ctx.lastName = claims.family_name;
  const phone = readStringOrFirst(claims.phone_number ?? claims.phoneNumber);
  if (phone) ctx.phoneNumber = phone;
  const phoneVerified = claims.phone_number_verified ?? claims.phoneNumberVerified;
  if (typeof phoneVerified === 'boolean') ctx.phoneNumberVerified = phoneVerified;
  else if (typeof phoneVerified === 'string') ctx.phoneNumberVerified = phoneVerified === 'true';
  const decision = readStringOrFirst(claims.decision_made);
  if (decision === 'pending' || decision === 'approved' || decision === 'rejected') {
    ctx.decisionMade = decision;
  }
  const aggregatorType = readStringOrFirst(claims.aggregator_type);
  // Accept any non-empty domain id — the network config (loaded at the
  // route layer) decides which values are valid for this deployment.
  if (aggregatorType) {
    ctx.aggregatorType = aggregatorType;
  }
  const signalstackOrgId = readStringOrFirst(claims.signalstack_org_id);
  if (signalstackOrgId) ctx.signalstackOrgId = signalstackOrgId;
  return { ok: true, context: ctx };
}

/**
 * Wrap {@link authenticate} with the approval gate. Rejects with
 * `NOT_APPROVED` when `decision_made` is missing or != `'approved'`. Use on
 * protected business endpoints (everything except `/auth/*` and the
 * profile-self-read which legitimately needs to surface "pending" status to
 * the applicant's own dashboard).
 *
 * When the token is missing the `signalstack_org_id` claim — typically
 * because the signalstack upsert failed during approval — the helper
 * synchronously backfills it before returning: looks up the aggregator's
 * name + slug, calls the (idempotent) admin upsert, writes the result on
 * the KC user as `signalstack_org_id`, and patches the in-flight
 * `AuthContext` so the current handler sees the value. The user's token
 * still lacks the claim until they refresh; subsequent requests carry it.
 *
 * Backfill failures are logged but do not block the request — the
 * authoritative gate is `decision_made`, and downstream handlers that
 * genuinely require an org id can re-check `context.signalstackOrgId`.
 */
export async function requireApproved(req: FastifyRequest): Promise<AuthResult> {
  const result = await authenticate(req);
  if (!result.ok) return result;
  if (result.context.decisionMade !== 'approved') {
    return {
      ok: false,
      error: {
        code: 'NOT_APPROVED',
        message: `aggregator approval pending (decision_made=${result.context.decisionMade ?? 'absent'})`,
      },
    };
  }
  if (!result.context.signalstackOrgId) {
    await backfillSignalstackOrgId(result.context);
  }
  return result;
}

/**
 * Best-effort backfill of `signalstack_org_id` on the authenticated user.
 *
 * Idempotent — safe to call repeatedly because the signalstack upsert
 * dedupes on `external_id`. Mutates the supplied context in place when a
 * value is resolved; logs and returns silently on every failure path so
 * the caller can continue.
 */
async function backfillSignalstackOrgId(ctx: AuthContext): Promise<void> {
  const start = Date.now();
  const log = logger.child({
    operation: 'auth.backfillSignalstackOrgId',
    aggregator_id: ctx.aggregatorId,
    user_id: ctx.userId,
  });

  const signalstack = getSignalStackWriter();
  if (!signalstack) {
    log.debug({ status: 'skipped', reason: 'signalstack_disabled' });
    return;
  }

  const store = getAggregatorStore();
  const found = await store.findById(ctx.aggregatorId);
  if (!found.ok) {
    log.warn(
      { status: 'failure', sub_operation: 'aggregatorStore.findById', code: found.error.code },
      'aggregator lookup failed during signalstack backfill',
    );
    return;
  }
  if (!found.value) {
    log.warn(
      { status: 'failure', sub_operation: 'aggregatorStore.findById', reason: 'not_found' },
      'aggregator row missing for approved KC user — manual cleanup required',
    );
    return;
  }

  // Resolve domains from the live network config (signalstack network.json)
  // so the backfill never overwrites org.metadata.domains with a stale
  // seeker/provider set on networks like orange_dot (tourist, practitioner).
  // Prefer the aggregator's registered type when set; otherwise send the
  // full domain list for the active network.
  const networkCfg = await getNetworkConfig();
  const aggregatorType = found.value.type;
  const upsertDomains: string[] =
    aggregatorType && networkCfg.domainIds.includes(aggregatorType)
      ? [aggregatorType]
      : networkCfg.domainIds;
  const upsert = await signalstack.upsertAggregator({
    external_id: ctx.aggregatorId,
    name: found.value.name,
    slug: found.value.orgSlug,
    domains: upsertDomains,
  });
  if (!upsert.success) {
    log.warn(
      {
        status: 'failure',
        sub_operation: 'signalstack.upsertAggregator',
        code: upsert.error.code,
        cause: upsert.error.message,
        latency_ms: Date.now() - start,
      },
      'signalstack aggregator upsert failed during login fallback',
    );
    return;
  }

  const idp = getIdpAdmin();
  const orgId = upsert.value.org_id;
  // Dual-write to KC attr + DB column. The DB mirror is what the worker
  // and anonymous public-link submission path read; the KC attribute is
  // what the next token refresh surfaces back as a claim. The current
  // request's context is patched in memory either way so the in-flight
  // handler sees the value without waiting for the refresh.
  const [attr, dbWrite] = await Promise.all([
    idp.setAttributes(ctx.userId, { [KC_ATTR.SIGNALSTACK_ORG_ID]: orgId }),
    store.updateSignalstackOrgId(ctx.aggregatorId, orgId, ctx.userId),
  ]);
  if (!attr.ok) {
    log.warn(
      {
        status: 'failure',
        sub_operation: 'idp.setAttributes.signalstack_org_id',
        code: attr.error.code,
        cause: attr.error.message,
      },
      'failed to stamp signalstack_org_id on KC user during login fallback',
    );
  }
  if (!dbWrite.ok) {
    log.warn(
      {
        status: 'failure',
        sub_operation: 'store.updateSignalstackOrgId',
        code: dbWrite.error.code,
        cause: dbWrite.error.message,
      },
      'failed to persist signalstack_org_id on aggregators row during login fallback',
    );
  }

  ctx.signalstackOrgId = orgId;
  if (attr.ok && dbWrite.ok) {
    log.info(
      {
        status: 'success',
        signalstack_org_id: orgId,
        latency_ms: Date.now() - start,
      },
      'signalstack_org_id backfilled on KC user + aggregators row',
    );
  }
}

/**
 * Verifies the Bearer token signature against the Keycloak JWKS without
 * requiring an `aggregator_id` claim. Use this on routes that may be
 * reached anonymously through the BFF (which then attaches a Keycloak
 * service-account token via the client_credentials grant).
 *
 * The middleware succeeds for both end-user tokens and service tokens.
 * Handlers can branch on `context.isUser` if they need to behave differently.
 */
export async function authenticateAny(req: FastifyRequest): Promise<AnyAuthResult> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return { ok: false, error: { code: 'MISSING_TOKEN', message: 'missing Bearer token' } };
  }
  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    return { ok: false, error: { code: 'MISSING_TOKEN', message: 'empty Bearer token' } };
  }

  let payload: JWTPayload;
  try {
    payload = await verifyToken(token);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'INVALID_TOKEN',
        message: err instanceof Error ? err.message : 'verify failed',
      },
    };
  }
  if (!payload.sub) {
    return { ok: false, error: { code: 'INVALID_TOKEN', message: 'missing sub claim' } };
  }
  const claims = payload as Record<string, unknown>;
  const aggregatorId = readAggregatorId(payload);
  const ctx: AnyAuthContext = {
    subject: payload.sub,
    isUser: Boolean(aggregatorId),
  };
  if (typeof claims.azp === 'string') ctx.authorizedParty = claims.azp;
  if (typeof claims.client_id === 'string') ctx.clientId = claims.client_id;
  if (aggregatorId) ctx.aggregatorId = aggregatorId;
  if (typeof claims.email === 'string') ctx.email = claims.email;
  return { ok: true, context: ctx };
}

function readStringOrFirst(v: unknown): string | undefined {
  if (typeof v === 'string' && v.length > 0) return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return undefined;
}

function readAggregatorId(payload: JWTPayload): string | undefined {
  // Keycloak protocol mappers can publish a user attribute as either a
  // single string or a one-element array claim — accept both shapes.
  const direct = (payload as Record<string, unknown>).aggregator_id;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  if (Array.isArray(direct) && typeof direct[0] === 'string') return direct[0];
  return undefined;
}

/**
 * Verifies a raw Bearer token against the Keycloak realm and returns its
 * claims.
 *
 * Beyond the signature + `iss` + `exp` checks jose performs, this adds two
 * client-scoping controls that stop a token minted for a *different* client
 * (or a different resource server) from being replayed against this API:
 *
 * - **`aud` (audience)** — when `KEYCLOAK_EXPECTED_AUDIENCE` is set, jose
 *   requires the token's `aud` to contain it. Off by default because it needs
 *   the realm's audience mapper (see `aggregator-realm.json`) to be present;
 *   enable it once tokens actually carry the API audience.
 * - **`azp` (authorized party)** — when `KEYCLOAK_ALLOWED_AZP` is set, the
 *   token's `azp` (the client that requested it) must be in that allow-list.
 *   Unlike `aud`, `azp` is always emitted by Keycloak, so this is the primary,
 *   deploy-safe gate.
 *
 * Both are no-ops when their env var is unset, preserving prior behaviour.
 *
 * @param token - The raw JWT from the `Authorization: Bearer` header.
 * @returns The verified JWT claim set.
 * @throws {Error} If verification fails, or `azp` is not in the allow-list.
 */
async function verifyToken(token: string): Promise<JWTPayload> {
  let payload: JWTPayload;
  if (testOverride) {
    payload = await testOverride(token);
  } else {
    const jwks = getJwks();
    const audience = expectedAudience();
    const { payload: verified } = await jwtVerify(token, jwks, {
      issuer: expectedIssuer(),
      ...(audience ? { audience } : {}),
    });
    payload = verified;
  }
  assertAllowedAzp(payload);
  return payload;
}

/**
 * Rejects a token whose `azp` is not in the configured allow-list.
 *
 * @param payload - The verified JWT claim set.
 * @throws {Error} If an allow-list is configured and `azp` is absent or not in it.
 */
function assertAllowedAzp(payload: JWTPayload): void {
  const allow = allowedAzp();
  if (allow.length === 0) return; // gate disabled when unconfigured
  const azp = (payload as Record<string, unknown>).azp;
  if (typeof azp !== 'string' || !allow.includes(azp)) {
    throw new Error(
      `token azp '${typeof azp === 'string' ? azp : 'absent'}' is not an allowed client`,
    );
  }
}

/** Optional expected token audience (`KEYCLOAK_EXPECTED_AUDIENCE`). */
function expectedAudience(): string | undefined {
  const v = process.env.KEYCLOAK_EXPECTED_AUDIENCE;
  return v && v.trim().length > 0 ? v.trim() : undefined;
}

/** Allow-listed `azp` client ids (`KEYCLOAK_ALLOWED_AZP`, comma-separated). */
function allowedAzp(): string[] {
  const v = process.env.KEYCLOAK_ALLOWED_AZP;
  if (!v) return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  const url = jwksUrl();
  if (cachedJwks && cachedJwksUrl === url) return cachedJwks;
  cachedJwks = createRemoteJWKSet(new URL(url));
  cachedJwksUrl = url;
  return cachedJwks;
}

function jwksUrl(): string {
  const base = mustEnv('KEYCLOAK_URL');
  const realm = mustEnv('KEYCLOAK_REALM');
  return `${base.replace(/\/+$/, '')}/realms/${realm}/protocol/openid-connect/certs`;
}

function expectedIssuer(): string {
  const base = mustEnv('KEYCLOAK_URL');
  const realm = mustEnv('KEYCLOAK_REALM');
  return `${base.replace(/\/+$/, '')}/realms/${realm}`;
}

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set`);
  return v;
}

/** Test helper — supply a fake token verifier. */
export function _setAccessTokenVerifier(fn: ((token: string) => Promise<JWTPayload>) | null): void {
  testOverride = fn;
}

/** Test helper — clear cached JWKS. */
export function _resetJwks(): void {
  cachedJwks = null;
  cachedJwksUrl = null;
}
