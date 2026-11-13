/**
 * BFF proxy to the aggregator API for anonymous (pre-session) routes only.
 *
 * Attaches a Keycloak service-account token, forwards the request, and passes
 * the upstream status and body through. It builds its own error body only when
 * the call cannot be made (bad JSON, no service token, network failure).
 * Never use it for routes that act for a signed-in user.
 *
 * @module apps/web/src/lib/bff-service-proxy
 */

import { type NextRequest, NextResponse } from 'next/server';
import { getServiceAccessToken } from './service-token';
import { logger, pickRequestId } from './logger';

const UPSTREAM_TIMEOUT_MS = 10_000;
const REQUEST_ID_HEADER = 'x-request-id';

/** Error body this proxy builds when the upstream call cannot be made. */
interface BffErrorEnvelope {
  error: { code: string; title: string; detail: string; requestId: string; timestamp: string };
}

function envelope(
  code: string,
  title: string,
  detail: string,
  requestId: string,
): BffErrorEnvelope {
  return { error: { code, title, detail, requestId, timestamp: new Date().toISOString() } };
}

function jsonError(status: number, body: BffErrorEnvelope, reqId: string): NextResponse {
  const res = NextResponse.json(body, { status });
  res.headers.set(REQUEST_ID_HEADER, reqId);
  return res;
}

/** Options describing the upstream call to proxy. */
export interface ServiceProxyOptions {
  /** Upstream path under `API_BASE_URL`, e.g. `/v1/orgs/create`. */
  path: string;
  /** HTTP method. */
  method: 'GET' | 'POST';
  /** Route label for structured logs, e.g. `POST /api/org/register`. */
  route: string;
  /** Parse + forward a JSON request body (POST). Ignored for GET. */
  forwardJsonBody?: boolean;
  /** `cache` mode for the upstream fetch (e.g. `no-store` for list reads). */
  cache?: RequestCache;
  /** Human noun for the UPSTREAM_UNAVAILABLE detail, e.g. "registration service". */
  offlineNoun?: string;
}

/**
 * Proxies an anonymous BFF request to the aggregator API with a service token.
 *
 * @param req - The incoming Next.js request.
 * @param opts - Upstream path/method + proxy behaviour.
 * @returns The upstream response, or a 400 (bad JSON) / 503 (IdP or upstream down).
 */
export async function proxyServiceRequest(
  req: NextRequest,
  opts: ServiceProxyOptions,
): Promise<NextResponse> {
  const reqId = pickRequestId(req.headers);
  const log = logger.child({ reqId, route: opts.route });
  const start = Date.now();
  const base = process.env.API_BASE_URL ?? 'http://localhost:4000';
  const offlineNoun = opts.offlineNoun ?? 'service';

  let body: unknown;
  if (opts.method === 'POST' && opts.forwardJsonBody) {
    try {
      body = await req.json();
    } catch (err) {
      log.warn(
        { code: 'BAD_JSON', cause: err instanceof Error ? err.message : String(err) },
        'invalid JSON body',
      );
      return jsonError(
        400,
        envelope('BAD_JSON', 'Invalid request', 'Request body is not valid JSON.', reqId),
        reqId,
      );
    }
  }

  let serviceToken: string;
  try {
    serviceToken = await getServiceAccessToken();
  } catch (err) {
    log.error(
      {
        code: 'IDP_UNAVAILABLE',
        sub_operation: 'getServiceAccessToken',
        cause: err instanceof Error ? err.message : String(err),
        hint: 'Keycloak token endpoint failed. Check KEYCLOAK_INTERNAL_URL + client credentials.',
      },
      'failed to fetch service token',
    );
    return jsonError(
      503,
      envelope(
        'IDP_UNAVAILABLE',
        'Identity service unavailable',
        'The identity service is temporarily unreachable. Please try again shortly.',
        reqId,
      ),
      reqId,
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${base}${opts.path}`, {
      method: opts.method,
      headers: {
        ...(opts.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Bearer ${serviceToken}`,
        [REQUEST_ID_HEADER]: reqId,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(opts.cache ? { cache: opts.cache } : {}),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    log.error(
      {
        code: 'UPSTREAM_UNAVAILABLE',
        sub_operation: 'fetch.aggregator-api',
        cause: err instanceof Error ? err.message : String(err),
        hint: 'Aggregator API unreachable from BFF. Check API_BASE_URL + network.',
      },
      'aggregator upstream call failed',
    );
    return jsonError(
      503,
      envelope(
        'UPSTREAM_UNAVAILABLE',
        'Service temporarily unavailable',
        `The ${offlineNoun} is offline. Please retry shortly.`,
        reqId,
      ),
      reqId,
    );
  }

  const latency_ms = Date.now() - start;
  const contentType = upstream.headers.get('content-type') ?? '';

  // Pass the upstream body through unchanged.
  if (contentType.includes('application/json')) {
    const data = (await upstream.json()) as unknown;
    log.info({ status: upstream.status, latency_ms }, 'upstream response forwarded');
    const res = NextResponse.json(data, { status: upstream.status });
    res.headers.set(REQUEST_ID_HEADER, reqId);
    return res;
  }

  const text = await upstream.text();
  log.info(
    { status: upstream.status, latency_ms, content_type: contentType },
    'upstream non-JSON response forwarded',
  );
  return new NextResponse(text, {
    status: upstream.status,
    headers: { 'Content-Type': contentType || 'text/plain', [REQUEST_ID_HEADER]: reqId },
  });
}
