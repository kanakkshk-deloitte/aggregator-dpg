/**
 * Org-owner grant-token mint and verify (`@aggregator-dpg/api`).
 *
 * The grant gives the org owner access to the invite-mint page. Same scheme as
 * `approval-token.ts` / `invite-token.ts`: HS256 via `jose`, issuer
 * `aggregator-api`, secret `APPROVAL_TOKEN_SECRET`, audience `aggregator-grant`.
 *
 * The grant lasts 90 days (`GRANT_TOKEN_TTL_SECONDS`); invites last 14. An
 * expired grant with a valid signature can be recovered (`allowExpired`): a
 * fresh link is emailed to the org's registered owner address, never a
 * request-supplied one.
 */

import { SignJWT, decodeJwt, errors as joseErrors } from 'jose';
import {
  TOKEN_ALG,
  TOKEN_ISSUER,
  getTokenKey,
  isJwtLike,
  verifyJwt,
  mapJoseError,
  _resetTokenKeyCache,
} from './token-common.js';

const AUDIENCE = 'aggregator-grant';
/** 90 days — overridable via `ttlSec` (`GRANT_TOKEN_TTL_SECONDS`). */
const DEFAULT_TTL_SEC = 90 * 24 * 60 * 60;

export interface MintGrantInput {
  /** The org id (`organisations.id`) the grant admits its holder to invite coordinators for. */
  org: string;
  /** Lifetime in seconds. Default 90 days. */
  ttlSec?: number;
}

export interface MintGrantResult {
  token: string;
  expiresAt: Date;
}

/**
 * Issues a signed owner-grant token bound to an org.
 *
 * @param input - `org` (parent_org_id) and optional TTL.
 * @returns The token string and its absolute expiry timestamp.
 * @throws {Error} If `APPROVAL_TOKEN_SECRET` is unset or too short.
 */
export async function mintGrantToken(input: MintGrantInput): Promise<MintGrantResult> {
  const ttl = input.ttlSec ?? DEFAULT_TTL_SEC;
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: TOKEN_ALG })
    .setSubject(input.org)
    .setIssuer(TOKEN_ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(getTokenKey());
  return { token, expiresAt };
}

export interface VerifyGrantOk {
  ok: true;
  /** The org id (`organisations.id`, token `sub`). */
  org: string;
  /** True when the token was accepted only because `allowExpired` was set. */
  expired: boolean;
}

export interface VerifyGrantErr {
  ok: false;
  error: { code: 'EXPIRED' | 'INVALID' | 'MALFORMED'; message: string };
}

export type VerifyGrantResult = VerifyGrantOk | VerifyGrantErr;

/**
 * Verifies a grant token's signature, audience, issuer, expiry, and `sub`.
 *
 * With `opts.allowExpired`, an expired grant with a valid signature is
 * accepted and flagged `expired: true`. Only the recovery path uses this.
 * Signature, issuer and audience failures always error.
 *
 * @param token - Raw grant JWT from the owner link.
 * @param opts - Set `allowExpired: true` for the recovery path.
 * @returns The `org` (+ `expired` flag) on success; a structured error otherwise.
 */
export async function verifyGrantToken(
  token: string,
  opts: { allowExpired?: boolean } = {},
): Promise<VerifyGrantResult> {
  if (!isJwtLike(token)) {
    return { ok: false, error: { code: 'MALFORMED', message: 'token is not a JWT' } };
  }
  try {
    const payload = await verifyJwt(token, AUDIENCE);
    if (!payload.sub) {
      return { ok: false, error: { code: 'INVALID', message: 'missing sub claim' } };
    }
    return { ok: true, org: payload.sub, expired: false };
  } catch (err) {
    return mapVerifyError(err, token, opts.allowExpired ?? false);
  }
}

/**
 * Maps a jose verify error to a {@link VerifyGrantResult}, applying the
 * expired-grant recovery path when allowed.
 *
 * @param err - The thrown jose error.
 * @param token - The original token (for the safe expired-payload decode).
 * @param allowExpired - Whether an expired-but-signed grant is acceptable.
 * @returns The verify result.
 */
function mapVerifyError(err: unknown, token: string, allowExpired: boolean): VerifyGrantResult {
  if (err instanceof joseErrors.JWTExpired && allowExpired) {
    // jose checks the signature before `exp`, so decoding an expired token here is safe.
    const payload = decodeJwt(token);
    if (!payload.sub) {
      return { ok: false, error: { code: 'INVALID', message: 'missing sub in expired grant' } };
    }
    return { ok: true, org: payload.sub, expired: true };
  }
  // Expired (recovery not allowed) → EXPIRED; everything else via the shared map.
  return { ok: false, error: mapJoseError(err) };
}

/** Test helper — clears the cached key so env changes take effect. */
export function _resetGrantTokenKey(): void {
  _resetTokenKeyCache();
}
