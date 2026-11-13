/**
 * Shared helpers for authenticated (session-backed) BFF proxy routes.
 *
 * Reads a JSON body, passes the upstream response through, and maps errors
 * thrown by `callApi` to the standard 401 or 503. For anonymous, pre-session
 * routes use `bff-service-proxy.ts` instead.
 *
 * @module apps/web/src/lib/bff-proxy
 */

import { type NextRequest, NextResponse } from 'next/server';
import { unauthorizedResponse, serviceUnavailableResponse } from './bff-errors';

/** The message `callApi` throws when there is no usable session. */
const NO_SESSION_MESSAGE = 'no active session';

/**
 * Forwards an upstream response to the caller unchanged.
 *
 * JSON bodies are re-sent as JSON; anything else is relayed as text with its
 * original content type. The body is not reshaped.
 *
 * @param upstream - The response returned by `callApi`.
 * @returns The equivalent `NextResponse`, preserving status and content type.
 */
export async function passthrough(upstream: Response): Promise<NextResponse> {
  const contentType = upstream.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const data = (await upstream.json()) as unknown;
    return NextResponse.json(data, { status: upstream.status });
  }
  const text = await upstream.text();
  return new NextResponse(text, {
    status: upstream.status,
    headers: { 'Content-Type': contentType || 'text/plain' },
  });
}

/**
 * Reports whether a caught error means there is no usable session.
 *
 * @param err - The value caught around a `callApi` invocation.
 * @returns True when the session was missing or could not be refreshed.
 */
export function isNoSession(err: unknown): boolean {
  return err instanceof Error && err.message === NO_SESSION_MESSAGE;
}

/**
 * Maps an error thrown by `callApi` to a 401 when the session is gone, else 503.
 *
 * @param err - The value caught around a `callApi` invocation.
 * @param service - Short service label used in the 503 code, e.g. `links`.
 * @returns The `unauthorizedResponse()` or `serviceUnavailableResponse()` body.
 */
export function proxyFailureResponse(err: unknown, service: string): NextResponse {
  if (isNoSession(err)) return unauthorizedResponse();
  return serviceUnavailableResponse(service, err instanceof Error ? err.message : undefined);
}

/** Outcome of {@link readJsonBody}: either the parsed body or a ready 400. */
export type JsonBodyResult = { ok: true; body: unknown } | { ok: false; response: NextResponse };

/**
 * Parses a request's JSON body, or returns a ready 400 when it is malformed.
 *
 * @param req - The incoming Next.js request.
 * @returns `{ ok: true, body }`, or `{ ok: false, response }` carrying the 400.
 */
export async function readJsonBody(req: NextRequest): Promise<JsonBodyResult> {
  try {
    return { ok: true, body: (await req.json()) as unknown };
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'BadRequest', message: 'invalid JSON' },
        { status: 400 },
      ),
    };
  }
}
