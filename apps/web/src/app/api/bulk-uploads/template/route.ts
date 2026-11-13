/**
 * BFF proxy: bulk-upload template download (CSV or XLSX).
 *   GET /api/bulk-uploads/template?participant_type=seeker[&sample=10][&format=xlsx]
 *
 * The body is forwarded as bytes, not text, so XLSX workbooks are not corrupted.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { callApi } from '../../../../lib/upstream-client';
import { unauthorizedResponse, serviceUnavailableResponse } from '../../../../lib/bff-errors';

export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const qs = req.nextUrl.search;
    const upstream = await callApi(`/v1/bulk-uploads/template${qs}`, { method: 'GET' });
    if (!upstream.ok) {
      const text = await upstream.text();
      return new NextResponse(text || 'upstream error', { status: upstream.status });
    }
    const body = await upstream.arrayBuffer();
    const ct = upstream.headers.get('content-type') ?? 'text/csv; charset=utf-8';
    const cd = upstream.headers.get('content-disposition') ?? 'attachment; filename="template.csv"';
    return new NextResponse(body, {
      status: 200,
      headers: { 'Content-Type': ct, 'Content-Disposition': cd },
    });
  } catch (err) {
    if (err instanceof Error && err.message === 'no active session') {
      return unauthorizedResponse();
    }
    return serviceUnavailableResponse(
      'bulk-uploads-template',
      err instanceof Error ? err.message : undefined,
    );
  }
}
