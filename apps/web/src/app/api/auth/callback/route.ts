/**
 * OIDC redirect URI — completes the login flow.
 *
 * - Reads the signed flow cookie set by `/api/auth/login`.
 * - Verifies state, exchanges the auth code (with PKCE verifier) for tokens.
 * - Persists the session in Redis.
 * - Drops the `sid` cookie.
 * - Redirects to the original `returnTo` path.
 *
 * GET /api/auth/callback?code=...&state=...
 */

import { type NextRequest, NextResponse } from 'next/server';
import { getOidcAdapter } from '@/lib/oidc';
import { getSessionStore, type SessionData } from '@/lib/session';
import { resolveSignalsRealmRoles } from '@/lib/signals-roles';
import {
  OIDC_FLOW_COOKIE,
  SESSION_COOKIE,
  clearCookieOptions,
  sessionCookieOptions,
  verifyFlowState,
} from '@/lib/cookies';
import { logger, pickRequestId } from '@/lib/logger';
import { PORTAL_GATE_REASON, classifyNonCoordinator, tokenAggregatorId } from '@/lib/jwt';

export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const reqId = pickRequestId(req.headers);
  const log = logger.child({ reqId, route: 'GET /api/auth/callback' });

  const url = req.nextUrl;
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const oidcError = url.searchParams.get('error');
  const oidcErrorDesc = url.searchParams.get('error_description');

  if (oidcError) {
    log.error(
      {
        code: 'OIDC_PROVIDER_ERROR',
        oidc_error: oidcError,
        oidc_error_description: oidcErrorDesc,
        hint: 'IdP returned error to redirect URI. User cancelled or IdP misconfig.',
      },
      'oidc error from idp',
    );
    return failure(req, `oidc_error_${oidcError}`);
  }
  if (!code || !state) {
    log.warn({ code: 'OIDC_MISSING_PARAMS' }, 'callback missing code or state param');
    return failure(req, 'missing_code_or_state');
  }

  const flowCookie = req.cookies.get(OIDC_FLOW_COOKIE)?.value;
  const flow = verifyFlowState(flowCookie);
  if (!flow) {
    log.warn(
      {
        code: 'OIDC_FLOW_COOKIE_INVALID',
        hint: 'Flow cookie missing/expired/tampered. User likely re-entered URL.',
      },
      'invalid flow cookie on callback',
    );
    return failure(req, 'invalid_flow_cookie');
  }

  const redirectUri = mustEnv('OIDC_REDIRECT_URI');
  const adapter = getOidcAdapter();
  const callbackParams: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    callbackParams[key] = value;
  });
  const exchanged = await adapter.exchangeCode({
    code,
    codeVerifier: flow.codeVerifier,
    redirectUri,
    state,
    expectedState: flow.state,
    expectedNonce: flow.nonce,
    callbackParams,
  });
  if (!exchanged.ok) {
    log.error(
      {
        code: exchanged.error.code,
        sub_operation: 'oidc.exchangeCode',
        cause: exchanged.error.message,
        hint: 'Token exchange with Keycloak failed. Check client_id/secret + redirect_uri allowlist.',
      },
      'oidc token exchange failed',
    );
    return failure(req, `exchange_${exchanged.error.code.toLowerCase()}`);
  }

  const { tokens, claims } = exchanged.value;

  // A coordinator (token has `aggregator_id`) lands in the portal. An org owner
  // or the network admin (realm role `org_owner`) lands in the console.
  // Anyone else is refused.
  const isCoordinator = Boolean(tokenAggregatorId(tokens.accessToken));
  const population = isCoordinator
    ? null
    : classifyNonCoordinator(tokens.accessToken, await resolveSignalsRealmRoles());
  if (population !== null && population !== 'org_owner') {
    // One Keycloak realm serves this portal and the Signals app, so a valid
    // token may belong to the other app. The reason tells the login page which.
    const reason = PORTAL_GATE_REASON[population];
    log.warn(
      {
        code: 'NO_AGGREGATOR_ID',
        sub: claims.sub,
        population,
        reason,
        hint: 'Authenticated KC user has no aggregator_id claim. Portal is coordinator-only; see reason for which account type.',
      },
      'blocking non-coordinator portal login',
    );
    return failure(req, reason);
  }

  const now = Date.now();
  const sessionData: SessionData = {
    sub: claims.sub,
    ...(claims.email ? { email: claims.email } : {}),
    ...(claims.phoneNumber ? { phone: claims.phoneNumber } : {}),
    ...(claims.name ? { name: claims.name } : {}),
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    idToken: tokens.idToken,
    accessTokenExp: tokens.accessTokenExp,
    refreshTokenExp: tokens.refreshTokenExp,
    createdAt: now,
    lastSeenAt: now,
  };
  const sid = await getSessionStore().create(sessionData);

  const res = NextResponse.redirect(absoluteUrl(req, landingPath(flow.returnTo, isCoordinator)), {
    status: 302,
  });
  res.cookies.set(SESSION_COOKIE, sid, sessionCookieOptions());
  res.cookies.set(OIDC_FLOW_COOKIE, '', clearCookieOptions());
  return res;
}

/**
 * Picks where a new session lands.
 *
 * Returns the requested path, except a coordinator never lands on `/console`
 * and an admin never lands on the coordinator portal.
 */
function landingPath(returnTo: string, isCoordinator: boolean): string {
  const inConsole = returnTo === '/console' || returnTo.startsWith('/console/');
  if (isCoordinator) return inConsole ? '/dashboard' : returnTo;
  return inConsole ? returnTo : '/console';
}

function failure(req: NextRequest, reason: string): NextResponse {
  const target = absoluteUrl(req, `/login?error=${encodeURIComponent(reason)}`);
  const res = NextResponse.redirect(target, { status: 302 });
  res.cookies.set(OIDC_FLOW_COOKIE, '', clearCookieOptions());
  return res;
}

function absoluteUrl(req: NextRequest, path: string): string {
  const base = process.env.PUBLIC_PORTAL_URL ?? req.nextUrl.origin;
  return new URL(path, base).toString();
}

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set`);
  return v;
}
