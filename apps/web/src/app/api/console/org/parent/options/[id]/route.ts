/**
 * Console BFF: the candidate parents for moving an organisation (network admin).
 *   GET /api/console/org/parent/options/:id → API GET /v1/org/parent/options/:id
 *
 * Read only. Sent with the caller's own token; the upstream response passes
 * through unchanged. The Move dialog reads it when it opens.
 */

import { type NextRequest, type NextResponse } from 'next/server';
import { callApi } from '@/lib/upstream-client';
import { passthrough, proxyFailureResponse } from '@/lib/bff-proxy';
import { invalidIdResponse, isUuid } from '@/lib/console-proxy';

export const runtime = 'nodejs';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!isUuid(id)) return invalidIdResponse();
  try {
    const upstream = await callApi(`/v1/org/parent/options/${id}`, { method: 'GET' });
    return await passthrough(upstream);
  } catch (err) {
    return proxyFailureResponse(err, 'console');
  }
}
