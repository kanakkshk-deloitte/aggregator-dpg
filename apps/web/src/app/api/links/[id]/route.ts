/**
 * BFF proxy for a single registration link.
 *   PATCH /api/links/:id → API PATCH /v1/links/:id
 *
 * Only drafts are editable; the API's 409 for other rows is passed through.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { callApi } from '../../../../lib/upstream-client';
import { passthrough, proxyFailureResponse } from '../../../../lib/bff-proxy';

export const runtime = 'nodejs';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'BadRequest', message: 'invalid JSON' }, { status: 400 });
  }
  try {
    const upstream = await callApi(`/v1/links/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body,
    });
    return await passthrough(upstream);
  } catch (err) {
    return proxyFailureResponse(err, 'links');
  }
}
