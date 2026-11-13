/**
 * Organisation console layout.
 *
 * Server Component. Requires a session and resolves the actor from
 * `GET /v1/user/read/me`, cached in the session for about 60 s. Coordinators go
 * to `/dashboard`; admins the API does not know, or without an active org, are
 * signed out with a reason.
 *
 * Uses the coordinator portal's sidebar frame. Contact support is off because
 * the support API accepts coordinators only.
 */

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { getSession } from '@/lib/server-session';
import { getConsoleActor } from '@/lib/console-actor';
import { getTranslations } from 'next-intl/server';
import { ConsoleSidebar } from '@/components/console/ConsoleSidebar';
import { AuthProvider } from '@/lib/auth-context';
import { can, canViewCoordinators, CONSOLE_HOME_HREF, coordinatorsHref } from '@/lib/capabilities';

export default async function ConsoleLayout({ children }: Readonly<{ children: ReactNode }>) {
  const session = await getSession();
  const path = (await headers()).get('x-pathname') ?? '/console';
  if (!session) redirect(`/api/auth/login?returnTo=${encodeURIComponent(path)}`);
  if (session.refreshTokenExp && session.refreshTokenExp <= Date.now()) {
    redirect(`/api/auth/logout?reason=expired&return=${encodeURIComponent(path)}`);
  }

  const actor = await getConsoleActor();
  if (!actor.ok) {
    if (actor.reason === 'no_session') {
      redirect(`/api/auth/login?returnTo=${encodeURIComponent(path)}`);
    }
    if (actor.reason === 'not_approved') redirect('/dashboard');
    if (actor.reason === 'unavailable') throw new Error('console unavailable');
    redirect(
      `/api/auth/logout?reason=${actor.reason === 'no_org' ? 'console_no_org' : 'console_not_provisioned'}`,
    );
  }
  if (actor.me.kind === 'coordinator') redirect('/dashboard');

  const t = await getTranslations('console');
  const me = actor.me;
  const name = me.user.contact.name ?? me.user.contact.email;
  return (
    <AuthProvider
      initialUser={{ id: me.user.id, name, org: '', email: me.user.contact.email }}
      supportEnabled={false}
      capabilities={me.capabilities ?? null}
    >
      {/* Column below `lg` (menu bar above the page), row from `lg` up, as in
          the coordinator portal (#793). */}
      <div className="flex flex-col lg:flex-row min-h-dvh">
        <ConsoleSidebar
          canManage={canViewCoordinators(me) && coordinatorsHref(me) !== CONSOLE_HOME_HREF}
          homeIsCoordinators={coordinatorsHref(me) === CONSOLE_HOME_HREF}
          canViewAccess={me.is_network_admin && can(me.capabilities, 'network.administer')}
          account={{
            title: name,
            subtitle: me.is_network_admin ? t('nav.network_admin') : t('nav.org_owner'),
            // No phone, no row. The popup skips a title that repeats the email.
            details: [
              { label: t('account.email'), value: me.user.contact.email, icon: 'mail' as const },
              ...(me.user.contact.phone
                ? [
                    {
                      label: t('account.phone'),
                      value: me.user.contact.phone,
                      icon: 'phone' as const,
                    },
                  ]
                : []),
            ],
          }}
        />
        <main className="flex-1 min-w-0 overflow-x-clip">
          <div className="max-w-[1480px] mx-auto px-4 py-5 sm:px-6 lg:px-8 lg:py-7">{children}</div>
        </main>
      </div>
    </AuthProvider>
  );
}
