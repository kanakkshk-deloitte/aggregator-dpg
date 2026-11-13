/**
 * BFF proxy for aggregator (coordinator) registration submissions.
 *
 * The caller has no session, so this attaches a service-account token and
 * forwards the body as-is to `/v1/aggregator-registrations/create`. Upstream
 * errors pass through.
 *
 * POST /api/aggregator/register
 */

import { type NextRequest, type NextResponse } from 'next/server';
import { proxyServiceRequest } from '../../../../lib/bff-service-proxy';

export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<NextResponse> {
  return proxyServiceRequest(req, {
    method: 'POST',
    path: '/v1/aggregator-registrations/create',
    route: 'POST /api/aggregator/register',
    forwardJsonBody: true,
    offlineNoun: 'registration service',
  });
}
