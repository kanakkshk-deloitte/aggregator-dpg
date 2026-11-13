/**
 * Standardised BFF error responses.
 *
 * The client `jsonFetch` wrapper uses the 401 body to detect an expired
 * session and force a re-login. BFF routes with no active session should
 * return `unauthorizedResponse()`, not a custom 401 body.
 */

import { NextResponse } from 'next/server';

/**
 * Builds the standard 401 response for a missing or unrefreshable session.
 *
 * Clients match on the `code` field.
 *
 * @returns A 401 JSON response with code `NO_ACTIVE_SESSION`.
 */
export function unauthorizedResponse(): NextResponse {
  return NextResponse.json(
    {
      error: 'Unauthorized',
      code: 'NO_ACTIVE_SESSION',
      message:
        'No active session cookie was found, or your session has expired. Sign in again at /login and retry the request.',
      hint: 'The BFF requires a valid `sid` cookie; the upstream API call was not attempted.',
    },
    { status: 401 },
  );
}

/**
 * Builds the standard 503 response for an unreachable upstream service.
 *
 * @param service - Short service label used in the response code.
 * @param detail - Optional low-level diagnostics.
 * @returns A 503 JSON response.
 */
export function serviceUnavailableResponse(service: string, detail?: string): NextResponse {
  return NextResponse.json(
    {
      error: 'ServiceUnavailable',
      code: `${service.toUpperCase().replaceAll('-', '_')}_UPSTREAM_FAILED`,
      message: `The ${service} service is temporarily unreachable. Please try again shortly.`,
      detail: detail ?? 'unknown error',
    },
    { status: 503 },
  );
}
