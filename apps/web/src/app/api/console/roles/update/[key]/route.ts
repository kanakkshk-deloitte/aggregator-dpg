/**
 * Console BFF: change a custom role (network admin).
 *   PATCH /api/console/roles/update/:key → API PATCH /v1/roles/update/:key
 *
 * Guarded by `consoleMutation` (JSON body, same-origin) and sent with the
 * caller's own token. The upstream response passes through unchanged.
 */

import { type NextRequest, type NextResponse } from 'next/server';
import { consoleMutation, invalidIdResponse, isRoleKey } from '@/lib/console-proxy';
import { customRolesEnabled } from '@/lib/features.server';

export const runtime = 'nodejs';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
): Promise<NextResponse> {
  // With custom roles off the api has no such route, so answer 404 here.
  if (!(await customRolesEnabled())) return invalidIdResponse();
  const { key } = await params;
  if (!isRoleKey(key)) return invalidIdResponse();
  return consoleMutation(req, {
    method: 'PATCH',
    path: `/v1/roles/update/${key}`,
    service: 'console',
  });
}
