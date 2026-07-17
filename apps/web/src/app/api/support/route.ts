/**
 * BFF proxy for contact-support submissions.
 *
 *   POST /api/support
 *
 * Forwards the authenticated user's `{ name, email?, phone?, type, details,
 * consent }` body verbatim to the aggregator API's `POST /v1/support`, which
 * emails it to the configured support address. Session cookie → access token
 * swap is handled by `callApi`.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { callApi } from '../../../lib/upstream-client';
import { unauthorizedResponse, serviceUnavailableResponse } from '../../../lib/bff-errors';

export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'BadRequest', message: 'invalid JSON' }, { status: 400 });
  }
  try {
    const upstream = await callApi('/v1/support', { method: 'POST', body });
    return await passthrough(upstream);
  } catch (err) {
    if (isNoSession(err)) {
      return unauthorizedResponse();
    }
    return serviceUnavailableResponse('support', err instanceof Error ? err.message : undefined);
  }
}

/**
 * Relays the upstream `Response` to the browser, preserving status and
 * body shape (JSON re-serialised, everything else passed through as text).
 *
 * @param upstream - Raw `Response` returned by `callApi`.
 * @returns A `NextResponse` mirroring the upstream status/body.
 */
async function passthrough(upstream: Response): Promise<NextResponse> {
  const ct = upstream.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    const data = (await upstream.json()) as unknown;
    return NextResponse.json(data, { status: upstream.status });
  }
  const text = await upstream.text();
  return new NextResponse(text, {
    status: upstream.status,
    headers: { 'Content-Type': ct || 'text/plain' },
  });
}

/**
 * Distinguishes `callApi`'s "no session" throw from other upstream
 * failures so the BFF can return 401 instead of 503.
 *
 * @param err - The caught error value.
 * @returns `true` if `callApi` threw because no session is active.
 */
function isNoSession(err: unknown): boolean {
  return err instanceof Error && err.message === 'no active session';
}
