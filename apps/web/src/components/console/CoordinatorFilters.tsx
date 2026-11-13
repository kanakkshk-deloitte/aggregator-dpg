'use client';

/**
 * The coordinator list's filters: organisation, status and served domain.
 *
 * A plain GET form; the page re-reads on the server. It applies when a filter
 * changes. The Apply button shows only without JavaScript. The organisation
 * filter shows only when the viewer reaches more than one organisation.
 */

import type { ChangeEvent, ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Building2, ChevronDown, CircleDot, Layers } from 'lucide-react';
import { Button } from '../ui/Button';
import type { OrgOption } from '../../lib/console-org-options';

const STATUSES = ['pending', 'active', 'inactive', 'retired'] as const;

/** Current filter values; empty means "all". */
export interface CoordinatorFilterValues {
  orgId: string;
  status: string;
  serves: string;
}

/**
 * Renders the filter bar.
 *
 * @param action - The page to submit to.
 * @param values - The current values.
 * @param orgs - The organisation choices, in tree order.
 * @param domains - The network's domains.
 */
export function CoordinatorFilters({
  action,
  values,
  orgs,
  domains,
}: Readonly<{
  action: string;
  values: CoordinatorFilterValues;
  orgs: readonly OrgOption[];
  domains: ReadonlyArray<{ id: string; label: string }>;
}>) {
  const t = useTranslations('console');
  /** Submits the form, leaving out "all" choices so the URL holds only real filters. */
  const submit = (e: ChangeEvent<HTMLSelectElement>) => {
    const form = e.currentTarget.form;
    if (!form) return;
    for (const el of Array.from(form.elements)) {
      if (el instanceof HTMLSelectElement && el.value === '') el.disabled = true;
    }
    form.requestSubmit();
  };
  /** A compact select with a leading icon; the label is for screen readers. */
  const field = (label: string, icon: ReactNode, select: ReactNode) => (
    <label
      title={label}
      className="relative flex h-9 items-center rounded-[10px] border border-(--bd-border) bg-(--bd-bg) text-ink-700 focus-within:border-(--bd-primary) focus-within:bg-(--bd-card) focus-within:shadow-[0_0_0_3px_var(--bd-primary-50)] hover:border-(--bd-primary-100)"
    >
      <span className="sr-only">{label}</span>
      <span aria-hidden="true" className="pointer-events-none absolute left-3 text-ink-400">
        {icon}
      </span>
      {select}
      <ChevronDown
        size={14}
        aria-hidden="true"
        className="pointer-events-none absolute right-2.5 text-ink-400"
      />
    </label>
  );
  const SELECT =
    'h-full max-w-[280px] cursor-pointer appearance-none truncate rounded-[10px] bg-transparent py-0 pr-8 pl-9 text-[13px] font-semibold outline-none';
  return (
    // Keyed on the values: a link to other filters (Clear filters, a chip) is a
    // client navigation, and the selects only read their value when created.
    <form
      key={`${values.orgId}|${values.status}|${values.serves}`}
      method="get"
      action={action}
      className="flex flex-wrap items-center gap-2"
    >
      {orgs.length > 1
        ? field(
            t('coordinators.org_filter'),
            <Building2 size={15} />,
            <select name="org_id" defaultValue={values.orgId} className={SELECT} onChange={submit}>
              <option value="">{t('coordinators.all_orgs')}</option>
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>,
          )
        : null}
      {field(
        t('coordinators.status_filter'),
        <CircleDot size={15} />,
        <select name="status" defaultValue={values.status} className={SELECT} onChange={submit}>
          <option value="">{t('coordinators.all')}</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`status.${s}`)}
            </option>
          ))}
        </select>,
      )}
      {domains.length > 0
        ? field(
            t('coordinators.serves_filter'),
            <Layers size={15} />,
            <select name="serves" defaultValue={values.serves} className={SELECT} onChange={submit}>
              <option value="">{t('coordinators.all_domains')}</option>
              {domains.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>,
          )
        : null}
      <noscript>
        <Button type="submit" kind="ghost">
          {t('coordinators.apply')}
        </Button>
      </noscript>
    </form>
  );
}
