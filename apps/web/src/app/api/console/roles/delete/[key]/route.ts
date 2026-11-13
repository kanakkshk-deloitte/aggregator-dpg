/**
 * Console BFF: delete an unused custom role (network admin).
 *   POST /api/console/roles/delete/:key → API POST /v1/roles/delete/:key
 *
 * Guarded by `consoleMutation` (JSON body, same-origin) and sent with the
 * caller's own token. The upstream response passes through unchanged.
 */

import { type NextRequest, type NextResponse } from 'next/server';
import { consoleMutation, invalidIdResponse, isRoleKey } from '@/lib/console-proxy';
import { customRolesEnabled } from '@/lib/features.server';

export const runtime = 'nodejs';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
): Promise<NextResponse> {
  // With custom roles off the api has no such route, so answer 404 here.
  if (!(await customRolesEnabled())) return invalidIdResponse();
  const { key } = await params;
  if (!isRoleKey(key)) return invalidIdResponse();
  return consoleMutation(req, {
    method: 'POST',
    path: `/v1/roles/delete/${key}`,
    service: 'console',
  });
}
