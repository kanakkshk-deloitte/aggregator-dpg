/**
 * RP-initiated logout.
 *
 * - Destroys the Redis session.
 * - Clears the `sid` cookie.
 * - Redirects to Keycloak's end-session endpoint with `id_token_hint` so the
 *   IdP-side SSO session is also killed.
 *
 * GET /api/auth/logout
 */

import { type NextRequest, NextResponse } from 'next/server';
import { getOidcAdapter } from '@/lib/oidc';
import { getSessionStore } from '@/lib/session';
import { SESSION_COOKIE, clearCookieOptions } from '@/lib/cookies';

export const runtime = 'nodejs';

/**
 * Short-lived cookies that carry the logout reason and return path to `/login`.
 *
 * Keycloak matches `post_logout_redirect_uri` exactly, so the redirect cannot
 * carry a query string. The login page reads and clears these cookies.
 */
const LOGOUT_REASON_COOKIE = 'bd_logout_reason';
const LOGOUT_RETURN_COOKIE = 'bd_logout_return';
const LOGOUT_HINT_MAX_AGE = 300; // 5 minutes

export async function GET(req: NextRequest): Promise<NextResponse> {
  const sid = req.cookies.get(SESSION_COOKIE)?.value;
  let idToken: string | null = null;
  if (sid) {
    const result = await getSessionStore().get(sid);
    if (result.ok) idToken = result.value.idToken;
    await getSessionStore().destroy(sid);
  }

  // Redirect to the bare /login path on the public portal URL. Inside Docker
  // `req.nextUrl.origin` is the container bind address, not the public URL.
  const publicBase =
    process.env.PUBLIC_PORTAL_URL ??
    (process.env.OIDC_POST_LOGOUT_REDIRECT_URI
      ? new URL(process.env.OIDC_POST_LOGOUT_REDIRECT_URI).origin
      : req.nextUrl.origin);
  const postLogoutRedirectUri = new URL('/login', publicBase).toString();

  let target = postLogoutRedirectUri;
  if (idToken) {
    const adapter = getOidcAdapter();
    target = await adapter.buildLogoutUrl({ idToken, postLogoutRedirectUri });
  }

  const reason = req.nextUrl.searchParams.get('reason');
  const returnTo = req.nextUrl.searchParams.get('return');

  const res = NextResponse.redirect(target, { status: 302 });
  res.cookies.set(SESSION_COOKIE, '', clearCookieOptions());

  const hintOpts = {
    httpOnly: false, // read by the login page; not sensitive
    sameSite: 'lax' as const,
    secure: req.nextUrl.protocol === 'https:',
    path: '/',
    maxAge: LOGOUT_HINT_MAX_AGE,
  };
  if (reason) res.cookies.set(LOGOUT_REASON_COOKIE, reason, hintOpts);
  if (returnTo) res.cookies.set(LOGOUT_RETURN_COOKIE, returnTo, hintOpts);

  return res;
}
