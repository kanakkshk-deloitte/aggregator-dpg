'use client';

/**
 * The network admin's organisations: a summary of the network with status
 * filters, then the organisations directly
 * under the network as a list. Search and the status filter run in the browser
 * over the loaded organisations.
 */

import Link from 'next/link';
import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import {
  ArrowRight,
  Building2,
  CircleCheck,
  CircleX,
  Clock,
  Globe,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { OrgSearchResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { I } from '../../icons';
import { cn } from '../../lib/cn';
import { ORG_FILTERS, countOrgs, matchesFilter, type OrgFilter } from '../../lib/org-filters';
import { ConsoleStatusPill } from './ConsoleUi';
import { CountTile, type TileTone } from './CountTile';

type OrgRow = OrgSearchResponse['orgs'][number];

const FILTER_TILE: Record<OrgFilter, { icon: LucideIcon; tone: TileTone }> = {
  all: { icon: Building2, tone: 'primary' },
  active: { icon: CircleCheck, tone: 'green' },
  pending: { icon: Clock, tone: 'amber' },
  inactive: { icon: CircleX, tone: 'rose' },
};

/** Columns shared by the header and every row. */
const COLS =
  'grid grid-cols-[minmax(0,1fr)_auto_72px] items-center gap-3.5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_90px]';

/** Whether an organisation's name or "known as" contains the search text (lower-cased). */
function matchesQuery(org: OrgRow, query: string): boolean {
  if (!query) return true;
  return `${org.name} ${org.known_as_name ?? org.known_as ?? ''}`.toLowerCase().includes(query);
}

export function NetworkOrgsView({
  rootName,
  orgs,
  more,
  initialFilter = 'all',
}: Readonly<{
  rootName: string;
  orgs: OrgRow[];
  /** More organisations exist than were loaded. */
  more: boolean;
  initialFilter?: OrgFilter;
}>) {
  const t = useTranslations('console');
  const [filter, setFilter] = useState<OrgFilter>(initialFilter);
  const [query, setQuery] = useState('');

  const counts = countOrgs(orgs);
  const q = query.trim().toLowerCase();
  const keep = (o: OrgRow) => matchesFilter(o, filter) && matchesQuery(o, q);
  // Default goes last: it holds sign-ups that came in without an organisation.
  const rows = orgs.filter(keep).sort((a, b) => Number(a.is_default) - Number(b.is_default));
  const filterLabel = (f: OrgFilter) => t(`orgs.tile.${f}.label`);

  return (
    <>
      <section className="bd-card bd-shadow overflow-hidden">
        <div className="flex flex-wrap items-center gap-3.5 px-[22px] py-5">
          <span className="grid h-10 w-10 flex-none place-items-center rounded-[11px] bg-(--bd-primary-50) text-(--bd-primary-600)">
            <Globe size={20} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <div className="truncate font-display text-[17px] font-extrabold text-ink-900">
              {rootName}
            </div>
            <div className="text-[12.5px] text-ink-500">{t('orgs.network_note')}</div>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
        {ORG_FILTERS.map((f) => {
          const { icon: Icon, tone } = FILTER_TILE[f];
          const n = counts[f];
          return (
            <CountTile
              key={f}
              icon={<Icon size={20} strokeWidth={2} />}
              tone={tone}
              label={filterLabel(f)}
              count={more ? `${n}+` : String(n)}
              sub={
                f === 'pending' && n === 0 ? t('orgs.tile.pending.none') : t(`orgs.tile.${f}.sub`)
              }
              muted={f === 'pending' && n === 0}
              selected={filter === f}
              showLabel={t('org_home.tile_show')}
              showingLabel={t('org_home.tile_showing')}
              onClick={() => setFilter(f)}
            />
          );
        })}
      </div>

      <section className="bd-card bd-shadow overflow-hidden">
        <header className="flex flex-wrap items-center gap-3 border-b border-(--bd-border-soft) px-[18px] py-3.5">
          <h2 className="flex items-center gap-2 font-display text-[15px] font-bold text-ink-900">
            {t('orgs.heading')}
            <span className="rounded-full bg-(--bd-border-soft) px-2 text-[12px] font-bold text-ink-500">
              {rows.length}
            </span>
          </h2>
          {filter === 'all' ? null : (
            <span className="inline-flex h-7 items-center gap-1.5 rounded-full bg-(--bd-primary-50) pr-1.5 pl-2.5 text-[12.5px] font-semibold text-(--bd-primary-600)">
              {filterLabel(filter)}
              <button
                type="button"
                onClick={() => setFilter('all')}
                aria-label={t('orgs.clear_filter')}
                className="grid h-5 w-5 place-items-center rounded-full hover:bg-(--bd-card)"
              >
                <X size={12} aria-hidden="true" />
              </button>
            </span>
          )}
          <div className="flex w-full flex-wrap gap-2 sm:ml-auto sm:w-auto">
            <label className="flex h-9 w-full items-center gap-2 rounded-[10px] border border-(--bd-border) bg-(--bd-bg) px-3 text-ink-500 focus-within:border-(--bd-primary) focus-within:bg-(--bd-card) focus-within:shadow-[0_0_0_3px_var(--bd-primary-50)] sm:w-[260px]">
              <I.search size={15} />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('orgs.search')}
                aria-label={t('orgs.search')}
                className="min-w-0 flex-1 bg-transparent text-[13.5px] text-ink-900 outline-none"
              />
            </label>
          </div>
        </header>

        <div
          className={cn(
            COLS,
            'border-b border-(--bd-border-soft) bg-(--bd-bg) px-[18px] py-2.5 text-[11px] font-bold tracking-[0.1em] text-ink-500 uppercase',
          )}
        >
          <span>{t('orgs.col_name')}</span>
          <span>{t('orgs.col_status')}</span>
          <span className="hidden lg:block">{t('orgs.col_known_as')}</span>
          <span className="hidden lg:block">{t('orgs.col_joined')}</span>
          <span>
            <span className="sr-only">{t('orgs.col_view')}</span>
          </span>
        </div>

        <div className="max-h-[min(640px,70vh)] overflow-auto overscroll-contain">
          {rows.length === 0 ? (
            <p className="px-[18px] py-10 text-center text-ink-500">
              {filter === 'pending' && !q ? t('orgs.empty_pending') : t('orgs.empty')}
            </p>
          ) : (
            rows.map((org) => <OrgRowLink key={org.id} org={org} />)
          )}
        </div>
        {more ? (
          <p className="border-t border-(--bd-border-soft) px-[18px] py-3 text-[12.5px] text-ink-500">
            {t('org.children_more')}
          </p>
        ) : null}
      </section>
    </>
  );
}

/** One organisation, opening its page. */
function OrgRowLink({ org }: Readonly<{ org: OrgRow }>) {
  const t = useTranslations('console');
  const format = useFormatter();
  // No one can set a value for the Default organisation.
  const knownAs = org.is_default ? null : (org.known_as_name ?? org.known_as);
  return (
    <Link
      href={`/console/orgs/${org.id}`}
      className={cn(
        COLS,
        'group border-b border-(--bd-border-soft) px-[18px] py-3 text-inherit no-underline last:border-b-0 hover:bg-(--bd-bg) hover:no-underline',
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid h-[34px] w-[34px] flex-none place-items-center rounded-[9px] bg-(--bd-primary-50) text-(--bd-primary-600)">
          <I.briefcase size={16} />
        </span>
        <span className="truncate font-bold text-ink-900">{org.name}</span>
      </div>
      <span className="justify-self-start">
        <ConsoleStatusPill status={org.status} />
      </span>
      <span className="hidden justify-self-start rounded-[7px] bg-(--bd-border-soft) px-2 py-0.5 text-[12px] font-semibold text-ink-700 lg:inline">
        {knownAs ?? '—'}
      </span>
      <span className="hidden text-[13px] text-ink-500 lg:block">
        {format.dateTime(new Date(org.created_at), {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        })}
      </span>
      <span className="flex items-center gap-1 justify-self-end rounded-lg px-2 py-1.5 text-[13px] font-semibold text-(--bd-primary-600) group-hover:bg-(--bd-primary-50)">
        {t('orgs.open')}
        <ArrowRight size={14} aria-hidden="true" />
      </span>
    </Link>
  );
}
