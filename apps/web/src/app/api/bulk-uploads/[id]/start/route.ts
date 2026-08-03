/**
 * BFF proxy: confirm bulk upload completion.
 *   POST /api/bulk-uploads/:id/start → API POST /v1/bulk-uploads/:id/start
 */

import { type NextRequest, NextResponse } from 'next/server';
import { callApi } from '../../../../../lib/upstream-client';
import { unauthorizedResponse, serviceUnavailableResponse } from '../../../../../lib/bff-errors';

export const runtime = 'nodejs';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  try {
    // Forward the JSON body (carries the operator `attestation` flag) to the
    // API, which validates + records it before enqueueing (#522 Task 1).
    // Pass a parsed object — callApi JSON.stringifies it (passing a string
    // would double-encode and the API would see a string, not an object).
    const body = (await req.json().catch(() => ({}))) as unknown;
    const upstream = await callApi(`/v1/bulk-uploads/${encodeURIComponent(id)}/start`, {
      method: 'POST',
      body: body ?? {},
    });
    return await passthrough(upstream);
  } catch (err) {
    if (isNoSession(err)) {
      return unauthorizedResponse();
    }
    return serviceUnavailableResponse(
      'bulk-uploads',
      err instanceof Error ? err.message : undefined,
    );
  }
}

async function passthrough(upstream: Response): Promise<NextResponse> {
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
}

function isNoSession(err: unknown): boolean {
  return err instanceof Error && err.message === 'no active session';
}
