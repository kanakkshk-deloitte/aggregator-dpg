/**
 * Coordinator invite-token mint and verify (`@aggregator-dpg/api`).
 *
 * Same scheme as `approval-token.ts`: HS256 via `jose`, issuer
 * `aggregator-api`, secret `APPROVAL_TOKEN_SECRET`. The audience
 * `aggregator-invite` stops other tokens sharing the secret from being
 * replayed as invites.
 *
 * Claims: `sub` (the `registration_invites` row `jti`), `org`, and `email`,
 * the invited address (recorded on submit, not enforced). Single use is enforced by the DB row's
 * `pending → consumed` update, not the token.
 */

import { SignJWT } from 'jose';
import {
  TOKEN_ALG,
  TOKEN_ISSUER,
  getTokenKey,
  isJwtLike,
  verifyJwt,
  mapJoseError,
  _resetTokenKeyCache,
} from './token-common.js';

const AUDIENCE = 'aggregator-invite';
const INVITE_ROLE = 'coordinator';
/** 14 days — overridable per-call via `ttlSec` (`INVITE_TOKEN_TTL_SECONDS`). */
const DEFAULT_TTL_SEC = 14 * 24 * 60 * 60;

/** The only invite role. */
export type InviteRole = typeof INVITE_ROLE;

export interface MintInviteInput {
  /** `jti` of the `registration_invites` row this token represents. */
  jti: string;
  /** The org id (`organisations.id`) the invite admits the coordinator to. */
  org: string;
  /** Invited email — bound; enforced against the submitted email. */
  email: string;
  /** Lifetime in seconds. Default 14 days. */
  ttlSec?: number;
}

export interface MintInviteResult {
  token: string;
  expiresAt: Date;
}

/**
 * Issues a signed coordinator-invite token bound to an invite row, org, and
 * recipient email.
 *
 * @param input - Invite `jti`, `org` (parent_org_id), bound `email`, optional TTL.
 * @returns The token string and its absolute expiry timestamp.
 * @throws {Error} If `APPROVAL_TOKEN_SECRET` is unset or too short.
 */
export async function mintInviteToken(input: MintInviteInput): Promise<MintInviteResult> {
  const ttl = input.ttlSec ?? DEFAULT_TTL_SEC;
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const token = await new SignJWT({ role: INVITE_ROLE, org: input.org, email: input.email })
    .setProtectedHeader({ alg: TOKEN_ALG })
    .setSubject(input.jti)
    .setIssuer(TOKEN_ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(getTokenKey());
  return { token, expiresAt };
}

export interface VerifyInviteOk {
  ok: true;
  /** `jti` of the invite row (token `sub`). */
  jti: string;
  role: InviteRole;
  /** The org id (`organisations.id`) from the token. */
  org: string;
  /** Bound recipient email (normalised at mint time). */
  email: string;
}

export interface VerifyInviteErr {
  ok: false;
  error: { code: 'EXPIRED' | 'INVALID' | 'MALFORMED'; message: string };
}

export type VerifyInviteResult = VerifyInviteOk | VerifyInviteErr;

/**
 * Verifies an invite token's signature, audience, issuer, expiry, and required
 * claims. There is no `allowExpired` mode; the owner re-sends expired invites.
 *
 * @param token - Raw JWT string from the coordinator invite link.
 * @returns Parsed `jti` / `org` / `email` / `role` on success; structured error otherwise.
 */
export async function verifyInviteToken(token: string): Promise<VerifyInviteResult> {
  if (!isJwtLike(token)) {
    return { ok: false, error: { code: 'MALFORMED', message: 'token is not a JWT' } };
  }
  try {
    const payload = await verifyJwt(token, AUDIENCE);
    if (!payload.sub) {
      return { ok: false, error: { code: 'INVALID', message: 'missing sub claim' } };
    }
    if (payload.role !== INVITE_ROLE) {
      return { ok: false, error: { code: 'INVALID', message: 'bad role claim' } };
    }
    const org = typeof payload.org === 'string' ? payload.org : '';
    const email = typeof payload.email === 'string' ? payload.email : '';
    if (!org || !email) {
      return { ok: false, error: { code: 'INVALID', message: 'missing org/email claim' } };
    }
    return { ok: true, jti: payload.sub, role: INVITE_ROLE, org, email };
  } catch (err) {
    return { ok: false, error: mapJoseError(err) };
  }
}

/** Test helper — clears the cached key so env changes take effect. */
export function _resetInviteTokenKey(): void {
  _resetTokenKeyCache();
}
