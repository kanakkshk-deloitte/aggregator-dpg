/**
 * BFF proxy for contact-support submissions.
 *
 *   POST /api/support
 *
 * Forwards the signed-in user's request body to the aggregator API's
 * `POST /v1/support`, which emails it to the configured support address.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { callApi } from '../../../lib/upstream-client';
import { passthrough, proxyFailureResponse } from '../../../lib/bff-proxy';

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
    return proxyFailureResponse(err, 'support');
  }
}
