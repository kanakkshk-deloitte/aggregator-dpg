/**
 * BFF proxy: bulk upload status read.
 *   GET /api/bulk-uploads/:id → API GET /v1/bulk-uploads/:id
 */

import { type NextRequest, type NextResponse } from 'next/server';
import { callApi } from '../../../../lib/upstream-client';
import { passthrough, proxyFailureResponse } from '../../../../lib/bff-proxy';

export const runtime = 'nodejs';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  try {
    const upstream = await callApi(`/v1/bulk-uploads/${encodeURIComponent(id)}`, { method: 'GET' });
    return await passthrough(upstream);
  } catch (err) {
    return proxyFailureResponse(err, 'bulk-uploads');
  }
}
