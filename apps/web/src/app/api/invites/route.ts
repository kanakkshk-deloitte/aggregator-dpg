/**
 * BFF proxy for the owner invite-mint endpoint.
 *
 * The caller has no session. Forwards `POST /admin/v1/invites` with a
 * service-account token; the owner GRANT token in the body authorises the
 * call. The upstream body is returned as-is.
 *
 * POST /api/invites
 */

import { type NextRequest, type NextResponse } from 'next/server';
import { proxyServiceRequest } from '../../../lib/bff-service-proxy';

export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<NextResponse> {
  return proxyServiceRequest(req, {
    method: 'POST',
    path: '/admin/v1/invites',
    route: 'POST /api/invites',
    forwardJsonBody: true,
    offlineNoun: 'invite service',
  });
}
