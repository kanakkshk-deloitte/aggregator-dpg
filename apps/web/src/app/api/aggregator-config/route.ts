/**
 * BFF proxy for the aggregator config.
 *
 *   GET /api/aggregator-config
 *
 * Forwards to the aggregator API's GET /v1/aggregator-config, which returns
 * the brand, domain labels and url slug. Unauthenticated: every value is public.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { serviceUnavailableResponse } from '../../../lib/bff-errors';

export const runtime = 'nodejs';

/**
 * Returns the aggregator config without a session.
 *
 * Calls the api without a Bearer token because pre-login pages need it.
 */
export async function GET(_req: NextRequest): Promise<NextResponse> {
  const base = process.env.API_BASE_URL ?? 'http://localhost:4000';
  try {
    const upstream = await fetch(`${base}/v1/aggregator-config`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });
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
    return serviceUnavailableResponse(
      'aggregator-config',
      err instanceof Error ? err.message : undefined,
    );
  }
}
