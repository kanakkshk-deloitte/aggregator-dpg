/**
 * Server-side reads for the console pages.
 *
 * Reads use the user's own token (`callApi`). A search is a `POST` upstream
 * but counts as a read here. Failures navigate: no session goes to login, a
 * lost entitlement signs out with a reason, out of reach is a 404.
 *
 * @module apps/web/src/lib/console-api.server
 */

import { notFound, redirect } from 'next/navigation';
import { callApi } from './upstream-client';

/**
 * Reads one console API resource, or navigates away.
 *
 * @param path - Upstream path, e.g. `/v1/org/read/<id>`.
 * @param body - When set, the read is a `POST` with this JSON body (search).
 * @returns The parsed JSON body.
 * @throws Navigation (redirect / notFound) on failure, as Next.js does.
 */
export async function consoleRead<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await callApi(path, body === undefined ? { method: 'GET' } : { method: 'POST', body });
  } catch {
    redirect('/api/auth/login?returnTo=/console');
  }
  if (res.status === 401) redirect('/api/auth/login?returnTo=/console');
  if (res.status === 404) notFound();
  if (res.status === 403) {
    const err = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
    const code = err?.error?.code;
    if (code === 'USER_NOT_PROVISIONED')
      redirect('/api/auth/logout?reason=console_not_provisioned');
    if (code === 'NOT_ORG_ADMIN') redirect('/api/auth/logout?reason=console_no_org');
    // Route not available to this actor: back to the console home.
    redirect('/console');
  }
  if (!res.ok) throw new Error(`console read failed (${res.status})`);
  return (await res.json()) as T;
}

/**
 * Reads an optional console resource, returning null on any failure.
 *
 * For panels that are hidden when unavailable, e.g. RBAC grants when access
 * control is off (503) or the caller lacks the capability (403).
 *
 * @param path - Upstream path.
 * @returns The parsed JSON body, or null.
 */
export async function consoleReadOptional<T>(path: string): Promise<T | null> {
  try {
    const res = await callApi(path, { method: 'GET' });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
