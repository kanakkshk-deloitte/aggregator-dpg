/**
 * BFF proxy exposing whether contact-support is enabled.
 *
 *   GET /api/support/config
 *
 * Forwards to the aggregator API's `GET /v1/support/config`. The web app
 * hides "Contact support" when `enabled` is `false`.
 */

import { NextResponse } from 'next/server';
import { callApi } from '../../../../lib/upstream-client';
import { unauthorizedResponse, serviceUnavailableResponse } from '../../../../lib/bff-errors';

export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  try {
    const upstream = await callApi('/v1/support/config', { method: 'GET' });
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
    return serviceUnavailableResponse('support', err instanceof Error ? err.message : undefined);
  }
}
