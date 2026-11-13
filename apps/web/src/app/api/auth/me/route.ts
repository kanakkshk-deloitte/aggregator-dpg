/**
 * Returns the public profile of the active session.
 *
 * Tokens never leave the BFF; only identity claims are returned.
 *
 * GET /api/auth/me  → 200 { sub, email?, phone?, name? } | 401
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/server-session';

export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  const s = await getSession();
  if (!s) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return NextResponse.json({
    user: {
      sub: s.sub,
      ...(s.email ? { email: s.email } : {}),
      ...(s.phone ? { phone: s.phone } : {}),
      ...(s.name ? { name: s.name } : {}),
    },
  });
}
