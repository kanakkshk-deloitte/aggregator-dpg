/**
 * BFF proxy: onboarding metrics summary.
 *   GET /api/onboarding/summary?from=&to=
 */

import { type NextRequest, type NextResponse } from 'next/server';
import { callApi } from '../../../../lib/upstream-client';
import { passthrough, proxyFailureResponse } from '../../../../lib/bff-proxy';

export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const qs = req.nextUrl.search;
    const upstream = await callApi(`/v1/onboarding/summary${qs}`, { method: 'GET' });
    return await passthrough(upstream);
  } catch (err) {
    return proxyFailureResponse(err, 'onboarding');
  }
}
