/**
 * Server-side session accessor.
 *
 * Wrapped in React's `cache()` so all Server Components in one request share
 * a single session-store lookup. Server-only; the browser-side provider is in
 * `auth-context.tsx`.
 */

import { cache } from 'react';
import { cookies } from 'next/headers';
import { getSessionStore } from './session';
import { SESSION_COOKIE } from './cookies';
import type { SessionData } from './session';

/**
 * Loads the active session, if any, for the current request.
 *
 * @returns Session data or `null` when no valid `sid` cookie is present.
 */
export const getSession = cache(async (): Promise<SessionData | null> => {
  const sid = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!sid) return null;
  const result = await getSessionStore().get(sid);
  return result.ok ? result.value : null;
});
