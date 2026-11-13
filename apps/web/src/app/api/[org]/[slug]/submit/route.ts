/**
 * BFF proxy for anonymous participant submissions.
 *
 * The caller is unauthenticated; the `(org, slug)` pair grants access.
 * Forwards the JSON body to `/public/v1/aggregators/:orgSlug/registrations/:slug`
 * with no Bearer or service token.
 *
 * POST /api/[org]/[slug]/submit
 */

import { randomUUID } from 'node:crypto';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

const UPSTREAM_TIMEOUT_MS = 10_000;
const REQUEST_ID_HEADER = 'x-request-id';
/**
 * Maximum public-submit body size in bytes.
 */
const MAX_BODY_BYTES = 32_000;

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

export async function POST(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { org, slug } = await params;
  const reqId = req.headers.get(REQUEST_ID_HEADER) ?? `req-${randomUUID()}`;

  const base = process.env.API_BASE_URL ?? 'http://localhost:4000';

  // Read raw text first to enforce the size cap before parsing JSON.
  let raw: string;
  try {
    raw = await req.text();
  } catch (err) {
    return jsonError(
      400,
      envelope(
        'BAD_REQUEST',
        'Invalid request',
        err instanceof Error ? err.message : 'Could not read request body.',
        reqId,
      ),
      reqId,
    );
  }
  if (raw.length > MAX_BODY_BYTES) {
    return jsonError(
      413,
      envelope(
        'PAYLOAD_TOO_LARGE',
        'Submission too large',
        `Request body exceeds ${MAX_BODY_BYTES} bytes.`,
        reqId,
      ),
      reqId,
    );
  }
  let body: unknown;
  try {
    body = raw.length === 0 ? {} : JSON.parse(raw);
  } catch {
    return jsonError(
      400,
      envelope('BAD_JSON', 'Invalid request', 'Request body is not valid JSON.', reqId),
      reqId,
    );
  }

  // Forward the client IP and user-agent so the API rate-limits per caller.
  // An existing `x-forwarded-for` chain is kept as-is.
  const incomingXff = req.headers.get('x-forwarded-for');
  const clientIp =
    (incomingXff?.split(',')[0]?.trim() ?? '') || ((req as { ip?: string }).ip ?? '');
  const forwardedFor = incomingXff && incomingXff.length > 0 ? incomingXff : clientIp;
  const userAgent = req.headers.get('user-agent') ?? '';

  let upstream: Response;
  try {
    upstream = await fetch(
      `${base}/public/v1/aggregators/${encodeURIComponent(org)}/registrations/${encodeURIComponent(slug)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [REQUEST_ID_HEADER]: reqId,
          ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
          ...(userAgent ? { 'user-agent': userAgent } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      },
    );
  } catch (err) {
    return jsonError(
      503,
      envelope(
        'UPSTREAM_UNAVAILABLE',
        'Service temporarily unavailable',
        err instanceof Error ? err.message : 'Could not reach the registration service.',
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
