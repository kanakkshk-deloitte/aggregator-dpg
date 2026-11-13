/**
 * BFF relay for the decrypted profile-data CSV export.
 *
 *   POST /api/dashboard/export/profiles
 *
 * Forwards the body to the aggregator API's POST /v1/dashboard/export/profiles
 * and returns the CSV or JSON error. Keeps the upstream `Content-Type`,
 * `Content-Disposition` and `X-Export-Skipped-Count` headers.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { callApi } from '../../../../../lib/upstream-client';
import { unauthorizedResponse, serviceUnavailableResponse } from '../../../../../lib/bff-errors';

export const runtime = 'nodejs';

/**
 * Relays a profile-data CSV export request to the aggregator API.
 *
 * @param req - Incoming POST request containing the JSON body with `item_ids` and `domain`.
 * @returns A NextResponse with the CSV payload or a JSON error envelope.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: { message: 'invalid JSON body' } }, { status: 400 });
  }

  try {
    const upstream = await callApi('/v1/dashboard/export/profiles', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/csv' },
      // Pass the parsed object; `callApi` stringifies it.
      body,
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
    const csv = await upstream.text();
    const headers: Record<string, string> = { 'Content-Type': ct || 'text/csv; charset=utf-8' };
    const disposition = upstream.headers.get('content-disposition');
    if (disposition) headers['Content-Disposition'] = disposition;
    // Number of requested ids the API withheld (not this aggregator's), so the
    // UI can tell the user the export is short.
    const skipped = upstream.headers.get('x-export-skipped-count');
    if (skipped) headers['X-Export-Skipped-Count'] = skipped;
    return new NextResponse(csv, { status: upstream.status, headers });
  } catch (err) {
    if (err instanceof Error && err.message === 'no active session') {
      return unauthorizedResponse();
    }
    return serviceUnavailableResponse(
      'dashboard-export-profiles',
      err instanceof Error ? err.message : undefined,
    );
  }
}
