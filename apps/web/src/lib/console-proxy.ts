/**
 * Shared helpers for the console's mutating BFF routes.
 *
 * Each mutation refuses cross-site or non-JSON requests ({@link rejectCrossSite}),
 * validates the path id, and forwards the JSON body with the caller's own token
 * via `callApi`. Never use the service token here. The upstream response is
 * passed through unchanged.
 *
 * @module apps/web/src/lib/console-proxy
 */

import { type NextRequest, NextResponse } from 'next/server';
import { callApi } from './upstream-client';
import { passthrough, proxyFailureResponse, readJsonBody } from './bff-proxy';
import { rejectCrossSite } from './same-origin';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a path segment is a UUID (the only id shape the console APIs take).
 *
 * @param id - The raw segment.
 * @returns True for a UUID.
 */
export function isUuid(id: string): boolean {
  return UUID_RE.test(id);
}

const ROLE_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * Whether a path segment is a role key (lower-case letters, digits, underscores).
 *
 * @param key - The raw segment.
 * @returns True for a role key.
 */
export function isRoleKey(key: string): boolean {
  return ROLE_KEY_RE.test(key);
}

/** Options of {@link consoleMutation}. */
export interface ConsoleMutationOptions {
  method: 'POST' | 'PATCH';
  /** Upstream path, already carrying a validated id. */
  path: string;
  /** Service label for the 503 code. */
  service: string;
}

/**
 * Runs one guarded console mutation.
 *
 * @param req - The incoming request.
 * @param opts - Method, upstream path, service label.
 * @returns The upstream response, or the guard's / proxy's error response.
 */
export async function consoleMutation(
  req: NextRequest,
  opts: ConsoleMutationOptions,
): Promise<NextResponse> {
  const refused = rejectCrossSite(req);
  if (refused) return refused;
  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  try {
    const upstream = await callApi(opts.path, { method: opts.method, body: body.body });
    return await passthrough(upstream);
  } catch (err) {
    return proxyFailureResponse(err, opts.service);
  }
}

/**
 * Builds the 404 response for a malformed id, matching an out-of-reach id upstream.
 *
 * @returns A 404 JSON response.
 */
export function invalidIdResponse(): NextResponse {
  return NextResponse.json({ error: { code: 'NOT_FOUND', title: 'Not found' } }, { status: 404 });
}
