/**
 * BFF proxy: create a bulk upload (returns presigned PUT URL).
 *   POST /api/bulk-uploads → API POST /v1/bulk-uploads
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
    const upstream = await callApi('/v1/bulk-uploads', { method: 'POST', body });
    return await passthrough(upstream);
  } catch (err) {
    return proxyFailureResponse(err, 'bulk-uploads');
  }
}
