/**
 * BFF proxy: confirm bulk upload completion.
 *   POST /api/bulk-uploads/:id/start → API POST /v1/bulk-uploads/:id/start
 */

import { type NextRequest, type NextResponse } from 'next/server';
import { callApi } from '../../../../../lib/upstream-client';
import { passthrough, proxyFailureResponse } from '../../../../../lib/bff-proxy';

export const runtime = 'nodejs';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  try {
    // The body carries the operator `attestation` flag. Pass the parsed object;
    // `callApi` stringifies it, so a string would be double-encoded.
    const body = (await req.json().catch(() => ({}))) as unknown;
    const upstream = await callApi(`/v1/bulk-uploads/${encodeURIComponent(id)}/start`, {
      method: 'POST',
      body: body ?? {},
    });
    return await passthrough(upstream);
  } catch (err) {
    return proxyFailureResponse(err, 'bulk-uploads');
  }
}
