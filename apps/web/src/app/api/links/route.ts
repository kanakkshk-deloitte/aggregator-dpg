/**
 * BFF proxy for registration links.
 *
 *   GET  /api/links?status=&limit=&offset=
 *   POST /api/links
 *
 * Forwards to the upstream API as-is with the session's bearer token.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { callApi } from '../../../lib/upstream-client';
import { passthrough, proxyFailureResponse } from '../../../lib/bff-proxy';

export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const qs = req.nextUrl.search;
    const upstream = await callApi(`/v1/links${qs}`, { method: 'GET' });
    return await passthrough(upstream);
  } catch (err) {
    return proxyFailureResponse(err, 'links');
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'BadRequest', message: 'invalid JSON' }, { status: 400 });
  }
  try {
    const upstream = await callApi('/v1/links/create', { method: 'POST', body });
    return await passthrough(upstream);
  } catch (err) {
    return proxyFailureResponse(err, 'links');
  }
}
