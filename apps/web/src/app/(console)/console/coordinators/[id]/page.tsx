/**
 * Coordinator detail page: a header with the coordinator's status and contact
 * details, approve or reject, and domains served.
 *
 * With access control on, also shows the coordinator's roles. Read-only for a
 * viewer who cannot manage the coordinator's organisation.
 */

import { notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Briefcase, CalendarDays, Mail, Phone } from 'lucide-react';
import type {
  RolesResponse,
  User,
  UserRolesResponse,
} from '@aggregator-dpg/shared-primitives/user-org';
import { consoleRead, consoleReadOptional } from '@/lib/console-api.server';
import { isUuid } from '@/lib/console-proxy';
import { getConsoleActor } from '@/lib/console-actor';
import { canManageOrg, canViewCoordinators, coordinatorsHref } from '@/lib/capabilities';
import { RolesPanel } from '@/components/console/RolesPanel';
import { Topbar } from '@/components/shell/Topbar';
import { BackLink, ConsoleStatusPill } from '@/components/console/ConsoleUi';
import { CopyButton } from '@/components/console/CopyButton';
import { networkDomains } from '@/lib/console-domains.server';
import { initialsOf } from '@/lib/initials';
import { CoordinatorActions } from '@/components/console/CoordinatorActions';

export default async function ConsoleCoordinatorPage({
  params,
}: Readonly<{
  params: Promise<{ id: string }>;
}>) {
  const t = await getTranslations('console');
  const format = await getFormatter();
  const { id } = await params;
  // Ids are UUIDs; anything else cannot exist, so it is a missing page, not an error.
  if (!isUuid(id)) notFound();
  const actor = await getConsoleActor();
  // The network admin has no users page.
  if (actor.ok && !canViewCoordinators(actor.me)) notFound();
  const [user, domains] = await Promise.all([
    consoleRead<User>(`/v1/user/read/${encodeURIComponent(id)}`),
    networkDomains(),
  ]);
  const displayName = user.contact.name ?? user.contact.email;
  const canManage = actor.ok && !!user.org_id && canManageOrg(actor.me, user.org_id);
  const [userRoles, catalogue] = await Promise.all([
    // Roles; absent when access control is off or not allowed.
    canManage
      ? consoleReadOptional<UserRolesResponse>(`/v1/user/roles/${encodeURIComponent(id)}`)
      : Promise.resolve(null),
    canManage ? consoleReadOptional<RolesResponse>('/v1/roles') : Promise.resolve(null),
  ]);
  return (
    <>
      <div>
        <BackLink href={actor.ok ? coordinatorsHref(actor.me) : '/console/coordinators'}>
          {t('coordinator.back')}
        </BackLink>
        <Topbar
          leading={
            <span
              aria-hidden="true"
              className="grid h-14 w-14 flex-none place-items-center rounded-full bg-(--bd-primary-50) font-display text-[19px] font-bold text-(--bd-primary-600)"
            >
              {initialsOf(displayName)}
            </span>
          }
          title={
            <span className="flex flex-wrap items-center gap-3">
              {displayName}
              <ConsoleStatusPill status={user.status} />
            </span>
          }
          subtitle={
            <span className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13.5px] text-ink-500">
              <span className="inline-flex items-center gap-1.5">
                <Briefcase size={15} aria-hidden="true" />
                <b className="font-semibold text-ink-700">{user.name}</b>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Mail size={15} aria-hidden="true" />
                {user.contact.email}
                <CopyButton value={user.contact.email} label={t('coordinator.copy_email')} />
              </span>
              {user.contact.phone ? (
                <span className="inline-flex items-center gap-1.5">
                  <Phone size={15} aria-hidden="true" />
                  {user.contact.phone}
                  <CopyButton value={user.contact.phone} label={t('coordinator.copy_phone')} />
                </span>
              ) : null}
              <span className="inline-flex items-center gap-1.5">
                <CalendarDays size={15} aria-hidden="true" />
                {t(user.status === 'pending' ? 'coordinator.registered' : 'coordinator.joined', {
                  date: format.dateTime(new Date(user.created_at), {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                  }),
                })}
              </span>
            </span>
          }
        />
      </div>
      <div className="flex flex-col gap-6">
        <CoordinatorActions user={user} domains={domains} readOnly={!canManage} />
        {userRoles && catalogue && user.org_id ? (
          <RolesPanel
            userId={user.id}
            orgId={user.org_id}
            initial={userRoles}
            roles={catalogue.roles}
            personName={displayName}
          />
        ) : null}
      </div>
    </>
  );
}
