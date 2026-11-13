/**
 * Console home page: the coordinators of an owner of one organisation. Child
 * organisations awaiting a decision are on the organisations page. Everyone
 * else is sent to the organisations page.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type {
  OrgReadResponse,
  OrgSearchResponse,
  UserSearchResponse,
} from '@aggregator-dpg/shared-primitives/user-org';
import { getConsoleActor } from '@/lib/console-actor';
import { consoleRead } from '@/lib/console-api.server';
import { canInvite, CONSOLE_HOME_HREF, coordinatorsHref } from '@/lib/capabilities';
import { networkDomains, servedDomains } from '@/lib/console-domains.server';
import { Topbar } from '@/components/shell/Topbar';
import { buttonClass } from '@/components/ui/button-class';
import { ConsoleStatusPill } from '@/components/console/ConsoleUi';
import { OrgCoordinators, type OrgCoordinatorRow } from '@/components/console/OrgCoordinators';
import { I } from '@/icons';

type OrgRow = OrgSearchResponse['orgs'][number];

/** Coordinators loaded for the single-organisation view, the API's page maximum. */
const ORG_HOME_LIMIT = 100;

export default async function ConsoleHomePage() {
  const actor = await getConsoleActor();
  if (!actor.ok) return null; // the layout already redirected
  const me = actor.me;
  // Everyone but an owner of one organisation works from the organisations page.
  if (coordinatorsHref(me) !== CONSOLE_HOME_HREF) redirect('/console/orgs');

  const homeOrgId = me.orgs.find((o) => o.org_type === 'aggregator' && !o.is_default)?.id;
  if (!homeOrgId) redirect('/console/orgs');
  const read = await consoleRead<OrgReadResponse>(`/v1/org/read/${homeOrgId}`);
  const homeOrg: OrgRow = {
    ...read.org,
    coordinator_count: read.coordinator_count,
    child_count: read.child_count,
    pending_count: read.pending_count,
  };
  return renderOrgHome(homeOrg, canInvite(me));
}

/** The owner's single organisation with its coordinators. */
async function renderOrgHome(org: OrgRow, showInvite: boolean) {
  const t = await getTranslations('console');
  const [page, domains] = await Promise.all([
    consoleRead<UserSearchResponse>('/v1/user/search', {
      filter: { org_id: org.id },
      limit: ORG_HOME_LIMIT,
    }),
    networkDomains(),
  ]);
  const rows: OrgCoordinatorRow[] = page.users.map((u) => ({
    id: u.id,
    name: u.contact.name ?? u.contact.email,
    email: u.contact.name ? u.contact.email : null,
    organisation: u.name,
    status: u.status,
    domains: servedDomains(u.serves, domains),
  }));
  return (
    <>
      <Topbar title={t('org_home.heading')} subtitle={t('org_home.subtitle')} />
      <div className="flex flex-col gap-4">
        <div className="bd-card bd-shadow flex flex-wrap items-center gap-3.5 px-5 py-4">
          <span className="grid h-10 w-10 flex-none place-items-center rounded-[11px] bg-(--bd-primary-50) text-(--bd-primary)">
            <I.briefcase size={20} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5 font-display text-[17px] font-extrabold text-ink-900">
              <span className="truncate">{org.name}</span>
              <ConsoleStatusPill status={org.status} />
            </div>
            <div className="text-[12.5px] text-ink-500">{t('org_home.owner_note')}</div>
          </div>
          {showInvite ? (
            <Link
              className={`${buttonClass('primary')} w-full justify-center sm:ml-auto sm:w-auto`}
              href="/console/invite"
            >
              <I.mail size={16} />
              {t('org_home.invite')}
            </Link>
          ) : null}
        </div>
        <OrgCoordinators
          rows={rows}
          total={org.coordinator_count}
          pending={org.pending_count}
          complete={page.next_cursor === null}
          allHref={`/console/coordinators?org_id=${org.id}`}
        />
      </div>
    </>
  );
}
