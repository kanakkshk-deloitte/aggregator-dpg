/**
 * Approval-token mint and verify, in the aggregator API (`@aggregator-dpg/api`).
 *
 * Each registration gets a signed JWT with the `aggregator_id` (sub) and an
 * `intent` claim, mailed to the reviewer as a link. The API verifies the
 * signature and required claims. A decision already made is detected from
 * stored state, so a reused link shows "already decided".
 *
 * HS256 with a secret of at least 32 bytes; the same service signs and verifies.
 */

import { SignJWT, jwtVerify, decodeJwt, errors as joseErrors } from 'jose';

const ALG = 'HS256';
const ISSUER = 'aggregator-api';
const AUDIENCE = 'aggregator-admin';
const DEFAULT_TTL_SEC = 60 * 60; // 1 hour

let cachedKey: Uint8Array | null = null;

function getKey(): Uint8Array {
  if (cachedKey) return cachedKey;
  const raw = process.env.APPROVAL_TOKEN_SECRET;
  if (!raw || raw.length < 32) {
    throw new Error('APPROVAL_TOKEN_SECRET must be set and at least 32 chars');
  }
  cachedKey = new TextEncoder().encode(raw);
  return cachedKey;
}

export interface MintInput {
  aggregatorId: string;
  intent: 'approve' | 'reject';
  /** Lifetime in seconds. Default 1h. */
  ttlSec?: number;
  /**
   * Org id the token is minted for. The decision handler requires it to match
   * the coordinator's org, so an owner's link decides only its own org's
   * coordinators. Omitted for org tokens.
   */
  org?: string;
}

export interface MintResult {
  token: string;
  expiresAt: Date;
}

/**
 * Issues a signed approval token bound to an aggregator + intent.
 *
 * @param input - Coordinator id, intent, optional TTL.
 * @returns Token string and absolute expiry timestamp.
 */
export async function mintApprovalToken(input: MintInput): Promise<MintResult> {
  const ttl = input.ttlSec ?? DEFAULT_TTL_SEC;
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const token = await new SignJWT({
    intent: input.intent,
    ...(input.org ? { org: input.org } : {}),
  })
    .setProtectedHeader({ alg: ALG })
    .setSubject(input.aggregatorId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(getKey());
  return { token, expiresAt };
}

/**
 * Renders a token lifetime as a phrase for the reviewer email and page, using
 * the largest whole unit: `604800` → "7 days", `5400` → "90 minutes",
 * `3661` → "3661 seconds".
 *
 * @param ttlSec - Lifetime in seconds (typically `APPROVAL_TOKEN_TTL_SECONDS`).
 * @returns A pluralised "N unit" phrase; "a limited time" for sub-second,
 *   non-positive, or non-finite input.
 */
export function formatApprovalTtl(ttlSec: number): string {
  if (!Number.isFinite(ttlSec) || ttlSec < 1) return 'a limited time';
  const whole = Math.floor(ttlSec);
  const units: ReadonlyArray<{ secs: number; one: string; many: string }> = [
    { secs: 86_400, one: 'day', many: 'days' },
    { secs: 3_600, one: 'hour', many: 'hours' },
    { secs: 60, one: 'minute', many: 'minutes' },
    { secs: 1, one: 'second', many: 'seconds' },
  ];
  for (const u of units) {
    if (whole >= u.secs && whole % u.secs === 0) {
      const n = whole / u.secs;
      return `${n} ${n === 1 ? u.one : u.many}`;
    }
  }
  // Unreachable: 1 second divides every integer; keeps the function total.
  return `${whole} seconds`;
}

export interface VerifyOk {
  ok: true;
  aggregatorId: string;
  intent: 'approve' | 'reject';
  /** Org id claim, when the token was minted with one. */
  org?: string;
}

export interface VerifyErr {
  ok: false;
  error: { code: 'EXPIRED' | 'INVALID' | 'MALFORMED'; message: string };
}

export type VerifyResult = VerifyOk | VerifyErr;

/**
 * Verifies a token's signature and required claims.
 *
 * With `opts.allowExpired`, an expired token with a valid signature is
 * accepted and its claims returned; the resend path uses this. Signature,
 * issuer and audience failures are always errors.
 *
 * @param token - Raw JWT string from the email link.
 * @param opts - Set `allowExpired: true` for the resend path.
 * @returns Parsed aggregator id + intent on success; structured error on failure.
 */
export async function verifyApprovalToken(
  token: string,
  opts: { allowExpired?: boolean } = {},
): Promise<VerifyResult> {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    return { ok: false, error: { code: 'MALFORMED', message: 'token is not a JWT' } };
  }
  try {
    const { payload } = await jwtVerify(token, getKey(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: [ALG],
    });
    if (!payload.sub) {
      return { ok: false, error: { code: 'INVALID', message: 'missing sub claim' } };
    }
    const intent = payload.intent;
    if (intent !== 'approve' && intent !== 'reject') {
      return { ok: false, error: { code: 'INVALID', message: 'bad intent claim' } };
    }
    const org = typeof payload.org === 'string' ? payload.org : undefined;
    return { ok: true, aggregatorId: payload.sub, intent, ...(org ? { org } : {}) };
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      if (opts.allowExpired) {
        // jose checks the signature before `exp`, so a JWTExpired error means the
        // signature is valid and the payload can be decoded.
        const payload = decodeJwt(token);
        const intent = payload.intent;
        if (!payload.sub || (intent !== 'approve' && intent !== 'reject')) {
          return { ok: false, error: { code: 'INVALID', message: 'bad claims in expired token' } };
        }
        const org = typeof payload.org === 'string' ? payload.org : undefined;
        return { ok: true, aggregatorId: payload.sub, intent, ...(org ? { org } : {}) };
      }
      return { ok: false, error: { code: 'EXPIRED', message: 'token expired' } };
    }
    if (err instanceof joseErrors.JWTInvalid || err instanceof joseErrors.JWSInvalid) {
      return { ok: false, error: { code: 'MALFORMED', message: err.message } };
    }
    if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
      return { ok: false, error: { code: 'INVALID', message: 'signature failed' } };
    }
    return {
      ok: false,
      error: { code: 'INVALID', message: err instanceof Error ? err.message : 'verify failed' },
    };
  }
}

/** Test helper — clears cached key so env changes take effect. */
export function _resetTokenKey(): void {
  cachedKey = null;
}
