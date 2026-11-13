/**
 * BFF proxy: activate (draft → live) a registration link.
 *   POST /api/links/:id/activate → API POST /v1/links/:id/activate
 */

import { type NextRequest, type NextResponse } from 'next/server';
import { callApi } from '../../../../../lib/upstream-client';
import { passthrough, proxyFailureResponse } from '../../../../../lib/bff-proxy';

export const runtime = 'nodejs';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  try {
    const upstream = await callApi(`/v1/links/${encodeURIComponent(id)}/activate`, {
      method: 'POST',
    });
    return await passthrough(upstream);
  } catch (err) {
    return proxyFailureResponse(err, 'links');
  }
}
