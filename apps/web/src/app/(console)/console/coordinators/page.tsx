/**
 * Lists the coordinators the actor can reach, filtered by organisation, status
 * and served domain; each active filter shows as a chip that removes it.
 *
 * Newest first, paged by the API's cursor. Each row names the organisation the
 * coordinator belongs to, with its "known as" label. With access control on,
 * an Access column shows each coordinator's additional roles. The invite
 * button is hidden from a viewer who cannot invite.
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type {
  OrgSearchResponse,
  RolesResponse,
  UserSearchResponse,
} from '@aggregator-dpg/shared-primitives/user-org';

type UserSearchOrg = OrgSearchResponse['orgs'][number];
import { consoleRead, consoleReadOptional } from '@/lib/console-api.server';
import { getConsoleActor } from '@/lib/console-actor';
import { canInvite, canViewCoordinators } from '@/lib/capabilities';
import { RoleBadges } from '@/components/console/RoleBadges';
import { networkDomains, servedDomains } from '@/lib/console-domains.server';
import { DomainChips } from '@/components/console/DomainChips';
import { initialsOf } from '@/lib/initials';
import { Clock, Eye, UserCheck, Users, UserX } from 'lucide-react';
import { CountTile, type TileTone } from '@/components/console/CountTile';
import { CoordinatorFilters } from '@/components/console/CoordinatorFilters';
import { readReachableOrgs } from '@/lib/console-hierarchy.server';
import { orgOptionsInTreeOrder } from '@/lib/console-org-options';
import { ConsoleSection, ConsoleStatusPill, EmptyState } from '@/components/console/ConsoleUi';
import { Topbar } from '@/components/shell/Topbar';
import { buttonClass } from '@/components/ui/button-class';
import { I } from '@/icons';

const STATUSES = ['pending', 'active', 'inactive', 'retired'] as const;
const UUID_RE = /^[0-9a-f-]{36}$/i;

/** Coordinators read per status to count it; more show as "N+". */
const COUNT_LIMIT = 100;

/** The status filters shown as counts above the list. */
const COUNTED = ['all', 'active', 'pending', 'inactive'] as const;
type Counted = (typeof COUNTED)[number];

/** One active filter, shown as a removable chip. */
interface FilterChip {
  key: string;
  label: string;
  value: string;
}

/** The coordinators list URL with these filters. */
function listHref(filters: Readonly<Record<string, string>>): string {
  const q = new URLSearchParams(filters).toString();
  return q ? `/console/coordinators?${q}` : '/console/coordinators';
}

/** The filters without one of them. */
function omit(filters: Readonly<Record<string, string>>, key: string): Record<string, string> {
  return Object.fromEntries(Object.entries(filters).filter(([k]) => k !== key));
}

export default async function ConsoleCoordinatorsPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<{ status?: string; org_id?: string; serves?: string; cursor?: string }>;
}>) {
  const t = await getTranslations('console');
  // The network admin has no users page.
  const viewer = await getConsoleActor();
  if (viewer.ok && !canViewCoordinators(viewer.me)) notFound();
  const params = await searchParams;
  const status = STATUSES.find((s) => s === params.status);
  const orgId = params.org_id && UUID_RE.test(params.org_id) ? params.org_id : undefined;
  const searchAfterDomains = networkDomains().then(async (domains) => {
    const serves = domains.find((d) => d.id === params.serves)?.id;
    const page = await consoleRead<UserSearchResponse>('/v1/user/search', {
      filter: {
        ...(status ? { status } : {}),
        ...(orgId ? { org_id: orgId } : {}),
        ...(serves ? { serves } : {}),
      },
      limit: 50,
      ...(params.cursor ? { cursor: params.cursor } : {}),
    });
    return { domains, serves, page };
  });
  const [{ domains, serves, page }, orgs, actor] = await Promise.all([
    searchAfterDomains,
    readReachableOrgs(),
    getConsoleActor(),
  ]);
  // Users are visible only in the orgs the viewer owns, so filters and counts use those.
  const ownedIds = new Set(actor.ok ? actor.me.orgs.map((o) => o.id) : []);
  const ownOrgs = orgs.filter((o) => ownedIds.has(o.id));
  const counts = await countCoordinators(ownOrgs, orgId, serves);
  const orgOptions = orgOptionsInTreeOrder(ownOrgs);
  const orgById = new Map(ownOrgs.map((o) => [o.id, o]));
  // Same gate the sidebar link used to apply, now checked here instead.
  const showInvite = actor.ok && canInvite(actor.me);
  const keep: Record<string, string> = {
    ...(orgId ? { org_id: orgId } : {}),
    ...(status ? { status } : {}),
    ...(serves ? { serves } : {}),
  };
  const chips: FilterChip[] = [];
  if (orgId) {
    const value = orgById.get(orgId)?.name ?? orgId;
    chips.push({ key: 'org_id', label: t('coordinators.org_filter'), value });
  }
  if (status) {
    chips.push({
      key: 'status',
      label: t('coordinators.status_filter'),
      value: t(`status.${status}`),
    });
  }
  if (serves) {
    const value = domains.find((d) => d.id === serves)?.label ?? serves;
    chips.push({ key: 'serves', label: t('coordinators.serves_filter'), value });
  }
  // Roles are null when access control is off: no Access column then.
  const showAccess = page.users.some((u) => Array.isArray(u.roles));
  const catalogue = showAccess ? await consoleReadOptional<RolesResponse>('/v1/roles') : null;
  const roleNames = Object.fromEntries((catalogue?.roles ?? []).map((r) => [r.key, r.name]));
  return (
    <>
      <Topbar title={t('coordinators.heading')} subtitle={t('coordinators.subtitle')} />
      <div className="flex flex-col gap-6">
        <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
          {COUNTED.map((f) => {
            const c = counts[f];
            const rest = omit(keep, 'status');
            const { icon: Icon, tone } = COUNT_TILE[f];
            const selected = (status ?? 'all') === f;
            return (
              <CountTile
                key={f}
                icon={<Icon size={20} strokeWidth={2} />}
                tone={tone}
                label={t(`org_home.tile.${f}.label`)}
                count={c.more ? `${c.n}+` : String(c.n)}
                sub={
                  f === 'pending' && c.n === 0
                    ? t('org_home.tile.pending.none')
                    : t(`org_home.tile.${f}.sub`)
                }
                muted={f === 'pending' && c.n === 0}
                selected={selected}
                showLabel={t('org_home.tile_show')}
                showingLabel={t('org_home.tile_showing')}
                href={listHref(f === 'all' ? rest : { ...rest, status: f })}
              />
            );
          })}
        </div>
        <ConsoleSection flush>
          <div className="flex flex-wrap items-center gap-3 border-b border-(--bd-border-soft) px-[18px] py-3.5">
            <h2 className="flex items-center gap-2 font-display text-[15px] font-bold text-ink-900">
              {t('coordinators.heading')}
              <span className="rounded-full bg-(--bd-border-soft) px-2 text-[12px] font-bold text-ink-500">
                {page.next_cursor ? `${page.users.length}+` : page.users.length}
              </span>
            </h2>
            <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
              <CoordinatorFilters
                action="/console/coordinators"
                values={{ orgId: orgId ?? '', status: status ?? '', serves: serves ?? '' }}
                orgs={orgOptions}
                domains={domains}
              />
              {showInvite ? (
                <Link className={buttonClass('primary')} href="/console/invite">
                  <I.mail size={14} />
                  {t('nav.invite')}
                </Link>
              ) : null}
            </div>
          </div>
          {chips.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2 border-b border-(--bd-border-soft) px-5 py-3">
              {chips.map((c) => (
                <Link
                  key={c.key}
                  href={listHref(omit(keep, c.key))}
                  aria-label={t('coordinators.clear_filter', { label: c.label })}
                  className="inline-flex items-center gap-1.5 rounded-full bg-[var(--bd-tint-primary)] px-3 py-1 text-[12.5px] text-primary-600 hover:underline"
                >
                  <span className="text-ink-500">{c.label}:</span>
                  <span className="font-semibold">{c.value}</span>
                  <I.x size={12} />
                </Link>
              ))}
              <Link
                href="/console/coordinators"
                className="text-[12.5px] text-ink-500 hover:text-ink-700 hover:underline"
              >
                {t('coordinators.clear_all')}
              </Link>
            </div>
          ) : null}
          {page.users.length === 0 ? (
            <EmptyState>{t('coordinators.empty')}</EmptyState>
          ) : (
            <div className="scroll-x max-h-[min(640px,70vh)] overflow-auto overscroll-contain">
              <table className="bd-table">
                <thead className="sticky top-0 z-[1]">
                  <tr>
                    <th>{t('coordinators.coordinator')}</th>
                    <th>{t('coordinators.organisation')}</th>
                    <th>{t('coordinators.status')}</th>
                    <th>{t('coordinators.serves')}</th>
                    {showAccess ? <th>{t('coordinators.access')}</th> : null}
                    <th>{t('org_home.col_action')}</th>
                  </tr>
                </thead>
                <tbody>
                  {page.users.map((u) => (
                    <tr key={u.id}>
                      <td>
                        <div className="flex min-w-0 items-center gap-3">
                          <span
                            aria-hidden="true"
                            className="grid h-[34px] w-[34px] flex-none place-items-center rounded-full bg-(--bd-primary-50) text-[12px] font-bold text-(--bd-primary-600)"
                          >
                            {initialsOf(u.contact.name ?? u.contact.email)}
                          </span>
                          <div className="min-w-0">
                            <Link
                              className="block truncate font-bold text-ink-900 hover:text-(--bd-primary-600) hover:underline"
                              href={`/console/coordinators/${u.id}`}
                            >
                              {u.contact.name ?? u.contact.email}
                            </Link>
                            {u.contact.name ? (
                              <div className="truncate text-[12.5px] text-ink-500">
                                {u.contact.email}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </td>
                      <td>
                        <OrgCell
                          org={u.org_id ? orgById.get(u.org_id) : undefined}
                          registeredName={u.name}
                        />
                      </td>
                      <td>
                        <ConsoleStatusPill status={u.status} />
                      </td>
                      <td>
                        <DomainChips domains={servedDomains(u.serves, domains)} />
                      </td>
                      {showAccess ? (
                        <td>
                          <RoleBadges roles={u.roles ?? []} names={roleNames} />
                        </td>
                      ) : null}
                      <td className="whitespace-nowrap">
                        {u.status === 'pending' ? (
                          <Link
                            href={`/console/coordinators/${u.id}`}
                            className="rounded-lg px-2.5 py-1.5 text-[13px] font-semibold text-(--bd-primary-600) hover:bg-(--bd-primary-50)"
                          >
                            {t('org_home.review')}
                          </Link>
                        ) : (
                          <Link
                            href={`/console/coordinators/${u.id}`}
                            aria-label={t('org_home.view_named', {
                              name: u.contact.name ?? u.contact.email,
                            })}
                            title={t('org_home.view')}
                            className="inline-grid h-8 w-8 place-items-center rounded-lg text-ink-500 hover:bg-(--bd-primary-50) hover:text-(--bd-primary-600)"
                          >
                            <Eye size={17} />
                          </Link>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </ConsoleSection>
        {page.next_cursor ? (
          <div>
            <a
              className={buttonClass('ghost')}
              href={`/console/coordinators?${new URLSearchParams({ ...keep, cursor: page.next_cursor }).toString()}`}
            >
              {t('coordinators.next')}
              <I.chevR size={14} />
            </a>
          </div>
        ) : null}
      </div>
    </>
  );
}

/** The organisation a coordinator belongs to, linked, with its "known as" label. */
function OrgCell({
  org,
  registeredName,
}: Readonly<{
  org: UserSearchOrg | undefined;
  registeredName: string;
}>) {
  if (!org) return <span className="text-ink-700">{registeredName}</span>;
  const knownAs = org.known_as_name ?? org.known_as;
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          className="text-ink-800 hover:text-primary-600 hover:underline"
          href={`/console/orgs/${org.id}`}
        >
          {org.name}
        </Link>
        {knownAs ? (
          <span className="rounded-md bg-[var(--bd-tint-primary)] px-1.5 py-0.5 text-[11.5px] font-semibold text-primary-600">
            {knownAs}
          </span>
        ) : null}
      </div>
    </div>
  );
}

const COUNT_TILE: Record<Counted, { icon: typeof Users; tone: TileTone }> = {
  all: { icon: Users, tone: 'primary' },
  active: { icon: UserCheck, tone: 'green' },
  pending: { icon: Clock, tone: 'amber' },
  inactive: { icon: UserX, tone: 'rose' },
};

/**
 * Counts the coordinators in reach by status. Without a domain filter the
 * total and pending counts are exact, from the organisations; the others
 * are counted from up to {@link COUNT_LIMIT} coordinators per status.
 *
 * @param orgs - The organisations in reach, with their counts.
 * @param orgId - The organisation filter, if any.
 * @param serves - The domain filter, if any.
 * @returns Each count, and whether more exist than were counted.
 */
async function countCoordinators(
  orgs: ReadonlyArray<UserSearchOrg>,
  orgId: string | undefined,
  serves: string | undefined,
): Promise<Record<Counted, { n: number; more: boolean }>> {
  const read = async (status?: 'active' | 'pending' | 'inactive') => {
    const r = await consoleRead<UserSearchResponse>('/v1/user/search', {
      filter: {
        ...(status ? { status } : {}),
        ...(orgId ? { org_id: orgId } : {}),
        ...(serves ? { serves } : {}),
      },
      limit: COUNT_LIMIT,
    });
    return { n: r.users.length, more: r.next_cursor !== null };
  };
  const scope = orgId ? orgs.filter((o) => o.id === orgId) : orgs;
  const exact = (n: number) => ({ n, more: false });
  const [active, inactive, all, pending] = await Promise.all([
    read('active'),
    read('inactive'),
    serves ? read() : exact(scope.reduce((n, o) => n + o.coordinator_count, 0)),
    serves ? read('pending') : exact(scope.reduce((n, o) => n + o.pending_count, 0)),
  ]);
  return { all, active, pending, inactive };
}
