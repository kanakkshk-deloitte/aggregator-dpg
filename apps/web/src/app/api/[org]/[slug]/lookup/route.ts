/**
 * BFF proxy for the anonymous identity-probe ("lookup") endpoint.
 *
 *   GET /api/[org]/[slug]/lookup?email|phone_number+network+domain
 *
 * Anonymous, like the submit route: no token is attached. Forwards the query
 * string to `/public/v1/aggregators/:orgSlug/lookup` and returns the upstream
 * status and body unchanged.
 */

import { randomUUID } from 'node:crypto';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

const UPSTREAM_TIMEOUT_MS = 10_000;
const REQUEST_ID_HEADER = 'x-request-id';

interface BffErrorEnvelope {
  error: {
    code: string;
    title: string;
    detail: string;
    requestId: string;
    timestamp: string;
  };
}

function envelope(
  code: string,
  title: string,
  detail: string,
  requestId: string,
): BffErrorEnvelope {
  return {
    error: { code, title, detail, requestId, timestamp: new Date().toISOString() },
  };
}

interface RouteParams {
  params: Promise<{ org: string; slug: string }>;
}

/**
 * Proxies the lookup query to the aggregator API.
 *
 * The upstream endpoint is keyed only on `org`; `slug` is ignored.
 *
 * @param req - The incoming request; the search params are forwarded as-is.
 * @param params - Path params; `org` becomes the upstream `:orgSlug`.
 * @returns Upstream response proxied with original status and body.
 */
export async function GET(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { org } = await params;
  const reqId = req.headers.get(REQUEST_ID_HEADER) ?? `req-${randomUUID()}`;

  const base = process.env.API_BASE_URL ?? 'http://localhost:4000';
  const search = new URL(req.url).searchParams.toString();

  // Forward the client IP and user-agent so the API rate-limits per caller.
  const incomingXff = req.headers.get('x-forwarded-for');
  const clientIp =
    (incomingXff?.split(',')[0]?.trim() ?? '') || ((req as { ip?: string }).ip ?? '');
  const forwardedFor = incomingXff && incomingXff.length > 0 ? incomingXff : clientIp;
  const userAgent = req.headers.get('user-agent') ?? '';

  let upstream: Response;
  try {
    upstream = await fetch(
      `${base}/public/v1/aggregators/${encodeURIComponent(org)}/lookup?${search}`,
      {
        method: 'GET',
        headers: {
          accept: 'application/json',
          [REQUEST_ID_HEADER]: reqId,
          ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
          ...(userAgent ? { 'user-agent': userAgent } : {}),
        },
        cache: 'no-store',
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      },
    );
  } catch (err) {
    return jsonError(
      503,
      envelope(
        'UPSTREAM_UNAVAILABLE',
        'Service temporarily unavailable',
        err instanceof Error ? err.message : 'Could not reach the lookup service.',
        reqId,
      ),
      reqId,
    );
  }

  const contentType = upstream.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const data = (await upstream.json()) as unknown;
    const res = NextResponse.json(data, { status: upstream.status });
    res.headers.set(REQUEST_ID_HEADER, reqId);
    return res;
  }

  const text = await upstream.text();
  return new NextResponse(text, {
    status: upstream.status,
    headers: { 'Content-Type': contentType || 'text/plain', [REQUEST_ID_HEADER]: reqId },
  });
}

function jsonError(status: number, body: BffErrorEnvelope, reqId: string): NextResponse {
  const res = NextResponse.json(body, { status });
  res.headers.set(REQUEST_ID_HEADER, reqId);
  return res;
}
