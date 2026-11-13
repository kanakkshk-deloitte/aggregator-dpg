/**
 * Cookie names, options, and helpers for the BFF auth flow.
 *
 * - `sid`: opaque session ID, set after a successful callback.
 * - `oidc_flow`: signed JSON with state, nonce, verifier and returnTo during
 *   the Keycloak login (5 min TTL).
 *
 * Tokens are never written to cookies; they are stored in Redis only.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME ?? 'sid';
export const OIDC_FLOW_COOKIE = 'oidc_flow';

const FIVE_MIN = 60 * 5;

function cookieSecure(): boolean {
  const v = process.env.COOKIE_SECURE;
  if (v === 'false') return false;
  if (v === 'true') return true;
  return process.env.NODE_ENV === 'production';
}

/**
 * Returns cookie attributes for the long-lived session cookie.
 */
export function sessionCookieOptions(): {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: 'lax',
    path: '/',
    maxAge: Number(process.env.SESSION_TTL_SECONDS ?? 60 * 60 * 12),
  };
}

/**
 * Returns cookie attributes for the short-lived OIDC handshake cookie.
 */
export function oidcFlowCookieOptions(): {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: 'lax',
    path: '/',
    maxAge: FIVE_MIN,
  };
}

/**
 * Returns cookie attributes that delete the cookie (`maxAge: 0`).
 */
export function clearCookieOptions(): {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  maxAge: 0;
} {
  return {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  };
}

export interface OidcFlowState {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
}

function getSigningKey(): string {
  const key = process.env.SESSION_KEY;
  if (!key || key.length < 32) {
    throw new Error('SESSION_KEY must be set and at least 32 chars');
  }
  return key;
}

/**
 * Encodes flow state as a signed JSON cookie value.
 *
 * Format: `<base64url(JSON)>.<hex(HMAC-SHA256)>`
 *
 * @param state - The flow state to sign.
 * @returns The cookie value.
 * @throws {Error} If `SESSION_KEY` is unset or shorter than 32 chars.
 */
export function signFlowState(state: OidcFlowState): string {
  const payload = Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
  const sig = createHmac('sha256', getSigningKey()).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

/**
 * Verifies signature and decodes flow state from a cookie value.
 *
 * @returns Parsed state, or `null` if signature invalid / payload corrupt.
 */
export function verifyFlowState(raw: string | undefined): OidcFlowState | null {
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot < 1) return null;
  const payload = raw.slice(0, dot);
  const provided = raw.slice(dot + 1);
  const expected = createHmac('sha256', getSigningKey()).update(payload).digest('hex');
  let provBuf: Buffer;
  let expBuf: Buffer;
  try {
    provBuf = Buffer.from(provided, 'hex');
    expBuf = Buffer.from(expected, 'hex');
  } catch {
    return null;
  }
  if (provBuf.length !== expBuf.length) return null;
  if (!timingSafeEqual(provBuf, expBuf)) return null;
  try {
    const json = Buffer.from(payload, 'base64url').toString('utf8');
    return JSON.parse(json) as OidcFlowState;
  } catch {
    return null;
  }
}
