/**
 * Layout for the protected coordinator pages.
 *
 * Server Component that runs on every `/(protected)/*` request. Without a
 * session it redirects to the BFF login with a `returnTo` back to the page.
 * It passes the session user, `supportEnabled`, and capabilities to the
 * client `AuthProvider`.
 */

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { Sidebar } from '../../components/shell/Sidebar';
import { AuthProvider } from '../../lib/auth-context';
import { getSession } from '../../lib/server-session';
import { PORTAL_GATE_REASON, classifyNonCoordinator, tokenAggregatorId } from '../../lib/jwt';
import { resolveSignalsRealmRoles } from '../../lib/signals-roles';
import { callApi } from '../../lib/upstream-client';
import type { User } from '../../types';
import { getConsoleActor } from '../../lib/console-actor';

/**
 * Fetches whether contact-support is enabled from `GET /v1/support/config`.
 *
 * Returns `false` on any upstream error, timeout, or unexpected response.
 *
 * @returns `true` if contact-support should be shown; `false` otherwise.
 */
async function fetchSupportEnabled(): Promise<boolean> {
  try {
    const res = await callApi('/v1/support/config', { method: 'GET' });
    if (!res.ok) return false;
    const data = (await res.json()) as { enabled?: unknown };
    return Boolean(data.enabled);
  } catch {
    return false;
  }
}

export default async function ProtectedLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  const path = (await headers()).get('x-pathname') ?? '/';

  if (!session) {
    redirect(`/api/auth/login?returnTo=${encodeURIComponent(path)}`);
  }

  // An expired refresh token ends the session. Log out to clear the cookie.
  const now = Date.now();
  if (session.refreshTokenExp && session.refreshTokenExp <= now) {
    redirect(`/api/auth/logout?reason=expired&return=${encodeURIComponent(path)}`);
  }

  // Only coordinators (tokens with `aggregator_id`) use this portal. Org
  // owners go to the console; everyone else is logged out with a reason.
  if (!tokenAggregatorId(session.accessToken)) {
    const population = classifyNonCoordinator(
      session.accessToken,
      await resolveSignalsRealmRoles(),
    );
    if (population === 'org_owner') redirect('/console');
    redirect(`/api/auth/logout?reason=${PORTAL_GATE_REASON[population]}`);
  }

  const user: User = {
    id: session.sub,
    name: session.name ?? session.email ?? session.phone ?? session.sub,
    org: session.email ?? '',
    ...(session.email ? { email: session.email } : {}),
    ...(session.phone ? { phone: session.phone } : {}),
  };
  const supportEnabled = await fetchSupportEnabled();
  // Capabilities hide UI the coordinator cannot use. On failure nothing is
  // hidden; the API still checks every request.
  const actor = await getConsoleActor();
  const capabilities = actor.ok ? (actor.me.capabilities ?? null) : null;

  return (
    <AuthProvider initialUser={user} supportEnabled={supportEnabled} capabilities={capabilities}>
      {/* Column layout below `lg`, row layout from `lg` up. */}
      <div className="flex flex-col lg:flex-row min-h-dvh">
        <Sidebar />
        <main className="flex-1 min-w-0 overflow-x-hidden">
          <div className="max-w-[1480px] mx-auto px-4 py-5 sm:px-6 lg:px-8 lg:py-7">{children}</div>
        </main>
      </div>
    </AuthProvider>
  );
}
