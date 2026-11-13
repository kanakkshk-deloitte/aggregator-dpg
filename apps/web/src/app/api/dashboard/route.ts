/**
 * BFF proxy for the signalstack-backed aggregator dashboard.
 *
 *   GET /api/dashboard?domain=seeker&page&limit&status
 *
 * Forwards to the aggregator API's GET /v1/dashboard with the session's
 * access token. Without `status`, the upstream returns the full rollup.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { callApi } from '../../../lib/upstream-client';
import { unauthorizedResponse, serviceUnavailableResponse } from '../../../lib/bff-errors';

export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const search = req.nextUrl.searchParams.toString();
  const path = `/v1/dashboard${search ? `?${search}` : ''}`;
  try {
    const upstream = await callApi(path, { method: 'GET' });
    const ct = upstream.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      const data = (await upstream.json()) as unknown;
      return NextResponse.json(data, { status: upstream.status });
    }
    const text = await upstream.text();
    return new NextResponse(text, {
      status: upstream.status,
      headers: { 'Content-Type': ct || 'text/plain' },
    });
  } catch (err) {
    if (err instanceof Error && err.message === 'no active session') {
      return unauthorizedResponse();
    }
    return serviceUnavailableResponse('dashboard', err instanceof Error ? err.message : undefined);
  }
}
