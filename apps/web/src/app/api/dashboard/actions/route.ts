/**
 * BFF endpoint for dashboard bulk actions.
 *
 *   POST /api/dashboard/actions
 *   { "action": "trigger_callback", "domain": "seeker", "ids": ["..."] }
 *
 * Stub: validates the request (session, allowed action, bounded id list),
 * logs it and returns 202. No upstream call is made. New actions go in
 * {@link ALLOWED_ACTIONS}.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { getSession } from '../../../../lib/server-session';
import { logger } from '../../../../lib/logger';
import { unauthorizedResponse } from '../../../../lib/bff-errors';

export const runtime = 'nodejs';

/** Server-side allowlist of bulk actions the BFF accepts. */
const ALLOWED_ACTIONS = new Set(['trigger_callback']);

/** Maximum ids per request. */
const MAX_IDS = 500;

interface BulkActionBody {
  action: string;
  domain: string;
  ids: string[];
}

/**
 * Validates the request body shape.
 *
 * @param raw - Parsed JSON body.
 * @returns The typed body, or an error message.
 */
function parseBody(raw: unknown): BulkActionBody | string {
  if (typeof raw !== 'object' || raw === null) return 'body must be a JSON object';
  const b = raw as Record<string, unknown>;
  if (typeof b.action !== 'string' || !b.action) return '`action` is required';
  if (!ALLOWED_ACTIONS.has(b.action)) return `unknown action: ${b.action}`;
  if (typeof b.domain !== 'string' || !b.domain) return '`domain` is required';
  if (!Array.isArray(b.ids) || b.ids.length === 0) return '`ids` must be a non-empty array';
  if (b.ids.length > MAX_IDS) return `\`ids\` exceeds the maximum of ${MAX_IDS}`;
  if (!b.ids.every((id) => typeof id === 'string' && id.length > 0)) {
    return '`ids` must contain non-empty strings';
  }
  return { action: b.action, domain: b.domain, ids: b.ids as string[] };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getSession();
  if (!session) return unauthorizedResponse();

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(
      { error: { message: 'invalid JSON', code: 'BAD_REQUEST' } },
      { status: 400 },
    );
  }

  const parsed = parseBody(raw);
  if (typeof parsed === 'string') {
    return NextResponse.json({ error: { message: parsed, code: 'BAD_REQUEST' } }, { status: 400 });
  }

  // Acknowledge only. Log the id count, never the ids.
  logger.info({
    operation: 'dashboard.bulkAction',
    status: 'skipped',
    action: parsed.action,
    domain: parsed.domain,
    id_count: parsed.ids.length,
  });

  return NextResponse.json({ accepted: parsed.ids.length }, { status: 202 });
}
