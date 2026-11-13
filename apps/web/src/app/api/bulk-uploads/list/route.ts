/**
 * BFF proxy: list bulk uploads (paginated).
 *   GET /api/bulk-uploads/list?limit=&offset=
 *
 * Lives at /list so it does not collide with the create route.
 */

import { type NextRequest, type NextResponse } from 'next/server';
import { callApi } from '../../../../lib/upstream-client';
import { passthrough, proxyFailureResponse } from '../../../../lib/bff-proxy';

export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const qs = req.nextUrl.search;
    const upstream = await callApi(`/v1/bulk-uploads${qs}`, { method: 'GET' });
    return await passthrough(upstream);
  } catch (err) {
    return proxyFailureResponse(err, 'bulk-uploads');
  }
}
