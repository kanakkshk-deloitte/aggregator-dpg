/**
 * Console BFF: re-apply an organisation owner's sign-in access (network admin).
 *   POST /api/console/org/repair/:id → API POST /v1/org/access/repair/:id
 *
 * Guarded by `consoleMutation` (JSON body, same-origin) and sent with the
 * caller's own token. The upstream response passes through unchanged.
 */

import { type NextRequest, type NextResponse } from 'next/server';
import { consoleMutation, invalidIdResponse, isUuid } from '@/lib/console-proxy';

export const runtime = 'nodejs';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!isUuid(id)) return invalidIdResponse();
  return consoleMutation(req, {
    method: 'POST',
    path: `/v1/org/access/repair/${id}`,
    service: 'console',
  });
}
