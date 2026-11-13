/**
 * BFF proxy for the active-org dropdown.
 *
 * Forwards `GET /v1/orgs` with a service-account token and returns the
 * upstream body as-is. Not cached, so newly approved orgs appear at once.
 *
 * GET /api/orgs
 */

import { type NextRequest, type NextResponse } from 'next/server';
import { proxyServiceRequest } from '../../../lib/bff-service-proxy';

export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<NextResponse> {
  return proxyServiceRequest(req, {
    method: 'GET',
    path: '/v1/orgs',
    route: 'GET /api/orgs',
    cache: 'no-store',
    offlineNoun: 'organisation list',
  });
}
