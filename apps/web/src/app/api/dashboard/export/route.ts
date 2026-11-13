/**
 * BFF proxy for the signalstack-backed aggregator dashboard CSV export.
 *
 *   GET /api/dashboard/export?domain=seeker&status=at_risk
 *
 * Forwards to the aggregator API's GET /v1/dashboard/export and returns the
 * CSV with the upstream `Content-Type` and `Content-Disposition` headers.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { callApi } from '../../../../lib/upstream-client';
import { unauthorizedResponse, serviceUnavailableResponse } from '../../../../lib/bff-errors';

export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const search = req.nextUrl.searchParams.toString();
  const path = `/v1/dashboard/export${search ? `?${search}` : ''}`;
  try {
    const upstream = await callApi(path, {
      method: 'GET',
      // The API currently ignores this header.
      headers: { accept: 'text/csv' },
    });
    const ct = upstream.headers.get('content-type') ?? '';
    // Errors come back as JSON so the client can show a toast.
    if (!upstream.ok) {
      if (ct.includes('application/json')) {
        const data = (await upstream.json()) as unknown;
        return NextResponse.json(data, { status: upstream.status });
      }
      const text = await upstream.text();
      return new NextResponse(text, {
        status: upstream.status,
        headers: { 'Content-Type': ct || 'text/plain' },
      });
    }
    // Success: relay the CSV and keep the filename and charset.
    const body = await upstream.text();
    const headers: Record<string, string> = {
      'Content-Type': ct || 'text/csv; charset=utf-8',
    };
    const disposition = upstream.headers.get('content-disposition');
    if (disposition) headers['Content-Disposition'] = disposition;
    return new NextResponse(body, { status: upstream.status, headers });
  } catch (err) {
    if (err instanceof Error && err.message === 'no active session') {
      return unauthorizedResponse();
    }
    return serviceUnavailableResponse(
      'dashboard-export',
      err instanceof Error ? err.message : undefined,
    );
  }
}
