/**
 * CSRF guard for the console's mutating BFF routes.
 *
 * Session cookies are `SameSite=Lax`, so a cross-site form POST still carries
 * them. Console mutations therefore require a JSON body and a same-origin
 * `Origin` header, or `Sec-Fetch-Site: same-origin` when `Origin` is absent.
 * A cross-site form cannot send JSON without a CORS preflight, which the BFF
 * never answers. Nothing in the console mutates on GET.
 *
 * @module apps/web/src/lib/same-origin
 */

import { type NextRequest, NextResponse } from 'next/server';

/**
 * Returns the origin the portal is served from.
 *
 * Uses `PUBLIC_PORTAL_URL` when set (in Docker the request origin is the
 * container address), else the request's own origin.
 *
 * @param req - The incoming request.
 * @returns The expected origin, e.g. `https://portal.example.org`.
 */
export function expectedOrigin(req: NextRequest): string {
  const configured = process.env.PUBLIC_PORTAL_URL;
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // A malformed PUBLIC_PORTAL_URL falls back to the request origin.
    }
  }
  return req.nextUrl.origin;
}

/**
 * Refuses a cross-site or non-JSON mutation.
 *
 * @param req - The incoming request.
 * @returns `null` when the request may proceed, else the 403 / 415 response.
 */
export function rejectCrossSite(req: NextRequest): NextResponse | null {
  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    return NextResponse.json(
      { error: { code: 'UNSUPPORTED_MEDIA_TYPE', title: 'JSON body required' } },
      { status: 415 },
    );
  }
  const origin = req.headers.get('origin');
  const sameOrigin = origin
    ? origin === expectedOrigin(req)
    : req.headers.get('sec-fetch-site') === 'same-origin';
  if (!sameOrigin) {
    return NextResponse.json(
      { error: { code: 'CROSS_SITE_REJECTED', title: 'Request refused' } },
      { status: 403 },
    );
  }
  return null;
}
