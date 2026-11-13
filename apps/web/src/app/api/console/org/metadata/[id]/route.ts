/**
 * Console BFF: update an organisation's details.
 *   PATCH /api/console/org/metadata/:id → API PATCH /v1/org/metadata/update/:id
 *
 * Guarded by `consoleMutation` (JSON body, same-origin) and sent with the
 * caller's own token. The upstream response passes through unchanged.
 */

import { type NextRequest, type NextResponse } from 'next/server';
import { consoleMutation, invalidIdResponse, isUuid } from '@/lib/console-proxy';

export const runtime = 'nodejs';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!isUuid(id)) return invalidIdResponse();
  return consoleMutation(req, {
    method: 'PATCH',
    path: `/v1/org/metadata/update/${id}`,
    service: 'console',
  });
}
