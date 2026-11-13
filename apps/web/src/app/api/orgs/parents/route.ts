/**
 * BFF proxy for the parent-org picker on organisation registration.
 *
 * Forwards `GET /v1/orgs/parents` with a service-account token and returns the
 * upstream body as-is. Not cached, so newly approved orgs appear at once.
 *
 * GET /api/orgs/parents
 */

import { type NextRequest, type NextResponse } from 'next/server';
import { proxyServiceRequest } from '../../../../lib/bff-service-proxy';

export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<NextResponse> {
  return proxyServiceRequest(req, {
    method: 'GET',
    path: '/v1/orgs/parents',
    route: 'GET /api/orgs/parents',
    cache: 'no-store',
    offlineNoun: 'organisation list',
  });
}
