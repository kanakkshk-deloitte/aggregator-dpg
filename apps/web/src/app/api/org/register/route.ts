/**
 * BFF proxy for organisation registration submissions.
 *
 * The caller has no session, so this attaches a service-account token and
 * forwards to `/v1/orgs/create`. Upstream errors pass through as-is.
 *
 * POST /api/org/register
 */

import { type NextRequest, type NextResponse } from 'next/server';
import { proxyServiceRequest } from '../../../../lib/bff-service-proxy';

export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<NextResponse> {
  return proxyServiceRequest(req, {
    method: 'POST',
    path: '/v1/orgs/create',
    route: 'POST /api/org/register',
    forwardJsonBody: true,
    offlineNoun: 'registration service',
  });
}
