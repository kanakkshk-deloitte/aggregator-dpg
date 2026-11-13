/**
 * BFF proxy for aggregator profile read + update.
 *
 *   GET   /api/aggregator/profile/me
 *   PATCH /api/aggregator/profile/me  — partial update of the aggregator row
 *
 * Requires a session; `callApi` attaches and refreshes the access token.
 * The body and response are forwarded as-is.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { callApi } from '../../../../../lib/upstream-client';
import { passthrough, proxyFailureResponse } from '../../../../../lib/bff-proxy';

export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  try {
    const upstream = await callApi('/v1/aggregators/profile/me', { method: 'GET' });
    return await passthrough(upstream);
  } catch (err) {
    return proxyFailureResponse(err, 'profile');
  }
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'BadRequest', message: 'invalid JSON' }, { status: 400 });
  }
  try {
    const upstream = await callApi('/v1/aggregators/profile/me', {
      method: 'PATCH',
      body,
    });
    return await passthrough(upstream);
  } catch (err) {
    return proxyFailureResponse(err, 'profile');
  }
}
