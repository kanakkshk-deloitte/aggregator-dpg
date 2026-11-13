/**
 * Shared HS256 signed-link token helpers (`@aggregator-dpg/api`).
 *
 * The invite and grant token services share the secret, issuer, JWT
 * pre-check and error mapping defined here. Each owns its audience and claims.
 */

import { jwtVerify, errors as joseErrors, type JWTPayload } from 'jose';

export const TOKEN_ALG = 'HS256';
export const TOKEN_ISSUER = 'aggregator-api';

let cachedKey: Uint8Array | null = null;

/**
 * Returns the shared signing key from `APPROVAL_TOKEN_SECRET`, cached.
 *
 * @returns The HS256 key bytes.
 * @throws {Error} If the secret is unset or shorter than 32 chars.
 */
export function getTokenKey(): Uint8Array {
  if (cachedKey) return cachedKey;
  const raw = process.env.APPROVAL_TOKEN_SECRET;
  if (!raw || raw.length < 32) {
    throw new Error('APPROVAL_TOKEN_SECRET must be set and at least 32 chars');
  }
  cachedKey = new TextEncoder().encode(raw);
  return cachedKey;
}

/** Test helper; clears the cached key so env changes take effect. */
export function _resetTokenKeyCache(): void {
  cachedKey = null;
}

/** Quick shape check so obvious non-JWTs fail as MALFORMED instead of throwing. */
export function isJwtLike(token: unknown): token is string {
  return typeof token === 'string' && token.length > 0 && token.includes('.');
}

/**
 * Verifies signature, issuer, audience and expiry, and returns the payload.
 *
 * Throws the jose error on failure; map it with {@link mapJoseError}.
 *
 * @param token - Raw JWT.
 * @param audience - Expected `aud` claim.
 * @returns The verified payload.
 */
export async function verifyJwt(token: string, audience: string): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, getTokenKey(), {
    issuer: TOKEN_ISSUER,
    audience,
    algorithms: [TOKEN_ALG],
  });
  return payload;
}

/** Structured verify failure shared by the token services. */
export interface TokenVerifyFailure {
  code: 'EXPIRED' | 'INVALID' | 'MALFORMED';
  message: string;
}

/**
 * Maps a thrown jose verify error to a structured failure.
 *
 * Callers with an expired-link recovery path handle `EXPIRED` themselves.
 *
 * @param err - The thrown jose error.
 * @returns The mapped failure.
 */
export function mapJoseError(err: unknown): TokenVerifyFailure {
  if (err instanceof joseErrors.JWTExpired) {
    return { code: 'EXPIRED', message: 'token expired' };
  }
  if (err instanceof joseErrors.JWTInvalid || err instanceof joseErrors.JWSInvalid) {
    return { code: 'MALFORMED', message: err.message };
  }
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
    return { code: 'INVALID', message: 'signature failed' };
  }
  return { code: 'INVALID', message: err instanceof Error ? err.message : 'verify failed' };
}
