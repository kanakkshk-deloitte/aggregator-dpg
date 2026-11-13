/**
 * Resolves the console's signed-in actor. Server-only.
 *
 * Reads `GET /v1/user/read/me` with the caller's own token and caches it in
 * the session for {@link ACTOR_CACHE_MS}, so lost access takes effect within
 * a minute.
 *
 * @module apps/web/src/lib/console-actor
 */

import { cookies } from 'next/headers';
import type { MeResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { SESSION_COOKIE } from './cookies';
import { getSessionStore } from './session';
import { getSession } from './server-session';
import { callApi } from './upstream-client';

/** How long a cached actor is trusted. */
export const ACTOR_CACHE_MS = 60_000;

/** Why the console cannot be shown. */
export type ConsoleActorFailure =
  'no_session' | 'not_provisioned' | 'no_org' | 'not_approved' | 'unavailable';

export type ConsoleActorResult =
  { ok: true; me: MeResponse } | { ok: false; reason: ConsoleActorFailure };

/** Maps the API's 403 code to a failure reason. */
function reasonOf(code: unknown): ConsoleActorFailure {
  if (code === 'USER_NOT_PROVISIONED') return 'not_provisioned';
  if (code === 'NOT_ORG_ADMIN') return 'no_org';
  if (code === 'NOT_APPROVED') return 'not_approved';
  return 'not_provisioned';
}

/**
 * Returns the signed-in actor, from the session cache when fresh.
 *
 * @returns The actor, or why there is none.
 */
export async function getConsoleActor(): Promise<ConsoleActorResult> {
  const session = await getSession();
  if (!session) return { ok: false, reason: 'no_session' };
  const cached = session.consoleActor;
  if (cached && Date.now() - cached.at < ACTOR_CACHE_MS) return { ok: true, me: cached.me };

  let res: Response;
  try {
    res = await callApi('/v1/user/read/me', { method: 'GET' });
  } catch (err) {
    if (err instanceof Error && err.message === 'no active session') {
      return { ok: false, reason: 'no_session' };
    }
    return { ok: false, reason: 'unavailable' };
  }
  if (res.status === 401) return { ok: false, reason: 'no_session' };
  if (res.status === 403) {
    const body = (await res.json().catch(() => null)) as { error?: { code?: unknown } } | null;
    return { ok: false, reason: reasonOf(body?.error?.code) };
  }
  if (!res.ok) return { ok: false, reason: 'unavailable' };
  const me = (await res.json()) as MeResponse;

  const sid = (await cookies()).get(SESSION_COOKIE)?.value;
  if (sid) await getSessionStore().update(sid, { consoleActor: { me, at: Date.now() } });
  return { ok: true, me };
}
