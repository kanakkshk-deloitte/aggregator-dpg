'use client';

/**
 * The network admin's read-only view of the access on the network: every role
 * and what it grants, every permission and which roles grant it, and a matrix
 * of both. The rows come from `GET /v1/rbac/roles` and `GET /v1/rbac/permissions`,
 * which read the catalogue the API enforces. Nothing here changes a role.
 *
 * Summary tiles open a tab or filter to permissions that expose personal data.
 * A search box narrows every tab, and permission and role chips link the tabs.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import {
  Check,
  CircleAlert,
  Globe,
  KeyRound,
  Lock,
  Plus,
  Search,
  Shield,
  TriangleAlert,
  Building2,
  type LucideIcon,
} from 'lucide-react';
import type {
  CataloguePermission,
  CatalogueRole,
} from '@aggregator-dpg/shared-primitives/user-org';
import { cn } from '../../lib/cn';
import { CountTile } from './CountTile';

/** Which view is on show. */
export type AccessTab = 'roles' | 'permissions' | 'matrix';

/** Where a role is held: the network organisation, or aggregator organisations. */
type Scope = 'network' | 'aggregator';

/** Lower-cased substring match; an empty query matches everything. */
const matches = (query: string, ...fields: string[]) =>
  !query || fields.some((f) => f.toLowerCase().includes(query));

/** The area a permission belongs to: the part before the first dot. */
const areaOf = (key: string) => key.split('.')[0] ?? key;

/** Where a role is held, for grouping. */
const scopeOf = (role: CatalogueRole): Scope =>
  role.held_in.includes('network_facilitator') ? 'network' : 'aggregator';

export function AccessCatalogue({
  tab,
  roles,
  permissions,
}: Readonly<{
  tab: AccessTab;
  roles: CatalogueRole[];
  permissions: CataloguePermission[];
}>) {
  const t = useTranslations('console.access');
  const [view, setView] = useState<AccessTab>(tab);
  const [query, setQuery] = useState('');
  const [personalOnly, setPersonalOnly] = useState(false);
  const [selected, setSelected] = useState<string | null>(roles[0]?.key ?? null);
  const [highlight, setHighlight] = useState<string | null>(null);

  const live = permissions.filter((p) => !p.retired);
  const personal = useMemo(
    () => new Set(permissions.filter((p) => p.personal_data).map((p) => p.key)),
    [permissions],
  );
  const q = query.trim().toLowerCase();
  const roleShown = (r: CatalogueRole) =>
    matches(q, r.name, r.key, r.description, ...r.permissions) &&
    (!personalOnly || r.permissions.some((p) => personal.has(p)));
  const permissionShown = (p: CataloguePermission) =>
    (!personalOnly || p.personal_data) &&
    matches(
      q,
      p.key,
      p.description,
      ...p.granted_by_roles.map((k) => roles.find((r) => r.key === k)?.name ?? k),
    );

  // Matrix columns narrow only when the search names a role; a search for a
  // permission keeps every role so its row still shows who grants it.
  const namedRoles = q ? roles.filter((r) => matches(q, r.name, r.key)) : [];
  const matrixRoles = namedRoles.length > 0 ? namedRoles : roles;

  function openRole(key: string) {
    setQuery('');
    setSelected(key);
    setView('roles');
  }

  function openPermission(key: string) {
    setQuery('');
    setPersonalOnly(false);
    setHighlight(key);
    setView('permissions');
  }

  const subtitles: Record<AccessTab, string> = {
    roles: t('subtitle_roles'),
    permissions: t('subtitle_permissions'),
    matrix: t('subtitle_matrix'),
  };

  return (
    <div className="flex flex-col gap-5">
      <p className="-mt-3 text-[14px] text-ink-500">{subtitles[view]}</p>

      <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
        <CountTile
          icon={<Shield size={20} strokeWidth={2} />}
          tone="primary"
          label={t('stat_roles')}
          count={String(roles.length)}
          sub={t('stat_roles_sub')}
          selected={view === 'roles' && !personalOnly}
          showLabel={t('tile_show')}
          showingLabel={t('tile_showing')}
          onClick={() => {
            setPersonalOnly(false);
            setView('roles');
          }}
        />
        <CountTile
          icon={<Lock size={20} strokeWidth={2} />}
          tone="primary"
          label={t('stat_permissions')}
          count={String(live.length)}
          sub={t('stat_permissions_sub')}
          selected={view === 'permissions' && !personalOnly}
          showLabel={t('tile_show')}
          showingLabel={t('tile_showing')}
          onClick={() => {
            setPersonalOnly(false);
            setView('permissions');
          }}
        />
        <CountTile
          icon={<TriangleAlert size={20} strokeWidth={2} />}
          tone="rose"
          label={t('stat_personal_data')}
          count={String(live.filter((p) => p.personal_data).length)}
          sub={t('stat_personal_data_sub')}
          selected={personalOnly}
          showLabel={t('tile_filter')}
          showingLabel={t('tile_filtering')}
          onClick={() => setPersonalOnly((v) => !v)}
        />
        <CountTile
          icon={<Plus size={20} strokeWidth={2} />}
          tone="primary"
          label={t('stat_custom')}
          count={String(roles.filter((r) => !r.is_builtin).length)}
          sub={t('stat_custom_sub')}
          muted={roles.every((r) => r.is_builtin)}
        />
      </div>

      <div className="sticky top-0 z-[5] -mx-1 flex flex-wrap items-center justify-between gap-3 bg-(--bd-bg) px-1 py-2.5">
        <div
          role="tablist"
          aria-label={t('title')}
          className="flex gap-0.5 rounded-[12px] border border-(--bd-border) bg-(--bd-card) p-1"
        >
          {(
            [
              ['roles', t('tab_roles'), roles.length],
              ['permissions', t('tab_permissions'), live.length],
              ['matrix', t('tab_matrix'), null],
            ] as const
          ).map(([id, label, count]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={view === id}
              onClick={() => setView(id)}
              className={cn(
                'flex h-[34px] items-center gap-2 rounded-lg px-3.5 text-[13.5px] font-semibold text-ink-500 hover:text-ink-900',
                view === id &&
                  'bg-(--bd-primary-50) text-(--bd-primary-600) hover:text-(--bd-primary-600)',
              )}
            >
              {label}
              {count === null ? null : (
                <span
                  className={cn(
                    'rounded-full bg-(--bd-border-soft) px-1.5 text-[11px] text-ink-500',
                    view === id && 'bg-(--bd-primary-100) text-(--bd-primary-600)',
                  )}
                >
                  {count}
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <button
            type="button"
            aria-pressed={personalOnly}
            onClick={() => setPersonalOnly((v) => !v)}
            className={cn(
              'flex h-10 items-center gap-2 rounded-[10px] border border-(--bd-border) bg-(--bd-card) px-3 text-[13px] font-semibold text-ink-700',
              personalOnly && 'border-rose-200 bg-rose-50 text-rose-700',
            )}
          >
            <TriangleAlert size={14} aria-hidden="true" />
            {t('personal_only')}
          </button>
          <label className="flex h-10 w-full items-center gap-2 rounded-[10px] border border-(--bd-border) bg-(--bd-card) px-3 text-ink-500 focus-within:border-(--bd-primary) focus-within:shadow-[0_0_0_3px_var(--bd-primary-50)] sm:w-[300px]">
            <Search size={16} aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setHighlight(null);
              }}
              placeholder={view === 'roles' ? t('search_roles') : t('search_permissions')}
              aria-label={view === 'roles' ? t('search_roles') : t('search_permissions')}
              className="min-w-0 flex-1 bg-transparent text-[13.5px] text-ink-900 outline-none"
            />
          </label>
        </div>
      </div>

      <p className="-mt-2 text-[12.5px] text-ink-500">{t('hint')}</p>

      {view === 'roles' ? (
        <RolesView
          roles={roles}
          permissions={permissions}
          personal={personal}
          shown={roleShown}
          selected={selected}
          onSelect={setSelected}
          onPermission={openPermission}
          query={query}
        />
      ) : null}
      {view === 'permissions' ? (
        <PermissionsView
          roles={roles}
          rows={permissions.filter(permissionShown)}
          highlight={highlight}
          onRole={openRole}
        />
      ) : null}
      {view === 'matrix' ? (
        <MatrixView roles={matrixRoles} rows={live.filter(permissionShown)} />
      ) : null}
    </div>
  );
}

/** A permission chip that opens it on the permissions tab. */
function PermissionChip({
  permission,
  danger,
  hit,
  title,
  onOpen,
}: Readonly<{
  permission: string;
  danger: boolean;
  hit: boolean;
  title?: string | undefined;
  onOpen: (key: string) => void;
}>) {
  return (
    <button
      type="button"
      title={title}
      onClick={() => onOpen(permission)}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border border-transparent px-2 py-0.5 font-mono text-[12px]',
        danger
          ? 'bg-rose-50 text-rose-700 hover:border-rose-200'
          : 'bg-(--bd-border-soft) text-ink-700 hover:border-(--bd-border) hover:bg-(--bd-card)',
        hit && 'outline-2 outline-offset-1 outline-(--bd-primary)',
      )}
    >
      {danger ? '● ' : ''}
      {permission}
    </button>
  );
}

/** A small rounded label. */
function Badge({ tone, children }: Readonly<{ tone: 'brand' | 'muted'; children: ReactNode }>) {
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-[10.5px] font-bold tracking-wide',
        tone === 'brand'
          ? 'bg-(--bd-primary-50) text-(--bd-primary-600)'
          : 'bg-(--bd-border-soft) text-ink-500',
      )}
    >
      {children}
    </span>
  );
}

/** The role list grouped by where roles are held, beside the selected role's detail. */
function RolesView({
  roles,
  permissions,
  personal,
  shown,
  selected,
  onSelect,
  onPermission,
  query,
}: Readonly<{
  roles: CatalogueRole[];
  permissions: CataloguePermission[];
  personal: Set<string>;
  shown: (r: CatalogueRole) => boolean;
  selected: string | null;
  onSelect: (key: string) => void;
  onPermission: (key: string) => void;
  query: string;
}>) {
  const t = useTranslations('console.access');
  const visible = roles.filter(shown);
  if (roles.length === 0) return <Empty>{t('roles_empty')}</Empty>;
  if (visible.length === 0) return <Empty>{t('no_match', { query })}</Empty>;
  const current = visible.find((r) => r.key === selected) ?? visible[0]!;
  const scopes: Array<{ id: Scope; icon: LucideIcon; title: string; hint: string }> = [
    { id: 'network', icon: Globe, title: t('scope_network'), hint: t('scope_network_hint') },
    {
      id: 'aggregator',
      icon: Building2,
      title: t('scope_aggregator'),
      hint: t('scope_aggregator_hint'),
    },
  ];
  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
      <div className="bd-card bd-shadow overflow-hidden py-2">
        {scopes.map((s, i) => {
          const list = visible.filter((r) => scopeOf(r) === s.id);
          if (list.length === 0) return null;
          return (
            <div
              key={s.id}
              className={cn(i > 0 && 'mt-1.5 border-t border-(--bd-border-soft) pt-2')}
            >
              <div className="flex items-center gap-2.5 px-[18px] pt-3 pb-2 text-[11px] font-bold tracking-[0.12em] text-ink-500 uppercase">
                <span className="grid h-6 w-6 place-items-center rounded-[7px] bg-(--bd-border-soft)">
                  <s.icon size={14} aria-hidden="true" />
                </span>
                {s.title}
                <span className="ml-auto text-[12px] font-medium tracking-normal normal-case text-ink-400">
                  {s.hint}
                </span>
              </div>
              {list.map((r) => {
                const assigned = r.granted.via === 'assignment';
                return (
                  <button
                    key={r.key}
                    type="button"
                    aria-pressed={current.key === r.key}
                    onClick={() => onSelect(r.key)}
                    className={cn(
                      'relative grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3.5 px-[18px] py-2.5 text-left hover:bg-(--bd-bg)',
                      current.key === r.key &&
                        'bg-(--bd-primary-50) before:absolute before:top-1.5 before:bottom-1.5 before:left-0 before:w-[3px] before:rounded-r before:bg-(--bd-primary) hover:bg-(--bd-primary-50)',
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span
                        className={cn(
                          'grid h-[30px] w-[30px] flex-none place-items-center rounded-lg',
                          assigned
                            ? 'bg-(--bd-border-soft) text-ink-500'
                            : 'bg-(--bd-primary-50) text-(--bd-primary-600)',
                        )}
                      >
                        {assigned ? (
                          <KeyRound size={15} aria-hidden="true" />
                        ) : (
                          <Shield size={15} aria-hidden="true" />
                        )}
                      </span>
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-2 font-bold text-ink-900">
                          {r.name}
                          <Badge tone={assigned ? 'muted' : 'brand'}>
                            {assigned ? t('via_assigned') : t('via_automatic')}
                          </Badge>
                          {r.is_builtin ? null : <Badge tone="muted">{t('custom')}</Badge>}
                        </span>
                        {r.description ? (
                          <span className="block truncate text-[12.5px] text-ink-500">
                            {r.description}
                          </span>
                        ) : null}
                      </span>
                    </span>
                    <span className="text-[12px] whitespace-nowrap text-ink-500">
                      {t('permission_count', { count: r.permissions.length })}
                    </span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
      <RoleDetail
        role={current}
        permissions={permissions}
        personal={personal}
        total={permissions.filter((p) => !p.retired).length}
        onPermission={onPermission}
        query={query}
      />
    </div>
  );
}

/** The selected role: who holds it, where, how, and its permissions by area. */
function RoleDetail({
  role,
  permissions,
  personal,
  total,
  onPermission,
  query,
}: Readonly<{
  role: CatalogueRole;
  permissions: CataloguePermission[];
  personal: Set<string>;
  total: number;
  onPermission: (key: string) => void;
  query: string;
}>) {
  const t = useTranslations('console.access');
  const assigned = role.granted.via === 'assignment';
  const pd = role.permissions.filter((p) => personal.has(p)).length;
  const byArea = new Map<string, string[]>();
  for (const p of role.permissions) byArea.set(areaOf(p), [...(byArea.get(areaOf(p)) ?? []), p]);
  const describe = (key: string) => permissions.find((p) => p.key === key)?.description;
  const q = query.trim().toLowerCase();
  return (
    <aside className="bd-card bd-shadow sticky top-[76px] flex flex-col" aria-label={role.name}>
      <div className="flex flex-col gap-2.5 border-b border-(--bd-border-soft) px-[22px] pt-5 pb-4">
        <div className="text-[12px] text-ink-500">
          {role.held_in.map((o) => t(`org_${o}`)).join(' · ')}
        </div>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-display text-[20px] font-bold text-ink-900">{role.name}</h3>
            <div className="font-mono text-[12px] text-ink-500">{role.key}</div>
          </div>
          <Badge tone={assigned ? 'muted' : 'brand'}>
            {assigned ? t('via_assigned') : t('via_automatic')}
          </Badge>
        </div>
        {role.description ? <p className="text-ink-700">{role.description}</p> : null}
        <div className="flex flex-wrap gap-1.5">
          <Meta>{t(`held_by_${role.held_by}`)}</Meta>
          {role.held_in.map((o) => (
            <Meta key={o}>{t(`org_${o}`)}</Meta>
          ))}
          {role.max_days ? <Meta>{t('valid_for', { count: role.max_days })}</Meta> : null}
        </div>
      </div>
      <div className="flex flex-col gap-3.5 px-[22px] pt-4 pb-5">
        <div className="grid grid-cols-3 gap-2">
          <MiniStat
            value={`${role.permissions.length}`}
            suffix={` / ${total}`}
            label={t('stat_permissions')}
          />
          <MiniStat value={String(pd)} label={t('personal_data')} warn={pd > 0} />
          <MiniStat value={role.max_days ? String(role.max_days) : '—'} label={t('max_days')} />
        </div>
        <div className="text-[11px] font-bold tracking-[0.1em] text-ink-500 uppercase">
          {t('stat_permissions')}
        </div>
        {role.permissions.length === 0 ? (
          <p className="text-[13px] text-ink-500">{t('permission_count', { count: 0 })}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {[...byArea.entries()].map(([area, list]) => (
              <div key={area} className="grid grid-cols-[76px_minmax(0,1fr)] items-start gap-2">
                <div className="pt-1 font-mono text-[11px] font-semibold text-ink-400">{area}</div>
                <div className="flex flex-wrap gap-1.5">
                  {list.map((p) => (
                    <PermissionChip
                      key={p}
                      permission={p}
                      danger={personal.has(p)}
                      hit={!!q && p.includes(q)}
                      title={describe(p)}
                      onOpen={onPermission}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-(--bd-border-soft) px-[22px] py-3 text-[12.5px] text-ink-500">
        {assigned ? t('footer_assigned') : t('footer_membership')}
      </div>
    </aside>
  );
}

/** A pill of role metadata. */
function Meta({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-(--bd-border) bg-(--bd-bg) px-2.5 py-0.5 text-[12px] text-ink-500">
      {children}
    </span>
  );
}

/** A small number with its label. */
function MiniStat({
  value,
  suffix,
  label,
  warn = false,
}: Readonly<{ value: string; suffix?: string; label: string; warn?: boolean }>) {
  return (
    <div className="rounded-[10px] border border-(--bd-border) bg-(--bd-bg) px-3 py-2.5">
      <b
        className={cn(
          'block font-display text-[18px] font-extrabold text-ink-900',
          warn && 'text-rose-600',
        )}
      >
        {value}
        {suffix ? <span className="text-[12px] font-semibold text-ink-500">{suffix}</span> : null}
      </b>
      <span className="text-[11.5px] text-ink-500">{label}</span>
    </div>
  );
}

/** Every permission, grouped by area, with what grants it. */
function PermissionsView({
  roles,
  rows,
  highlight,
  onRole,
}: Readonly<{
  roles: CatalogueRole[];
  rows: CataloguePermission[];
  highlight: string | null;
  onRole: (key: string) => void;
}>) {
  const t = useTranslations('console.access');
  if (rows.length === 0) return <Empty>{t('permissions_empty')}</Empty>;
  const areas = new Map<string, CataloguePermission[]>();
  for (const p of rows) areas.set(areaOf(p.key), [...(areas.get(areaOf(p.key)) ?? []), p]);
  const nameOf = (key: string) => roles.find((r) => r.key === key)?.name ?? key;
  return (
    <div className="bd-card bd-shadow overflow-auto">
      <table className="bd-table">
        <thead className="sticky top-0 z-[1]">
          <tr>
            <th>{t('col_permission')}</th>
            <th>{t('col_description')}</th>
            <th>{t('col_personal_data')}</th>
            <th>{t('col_granted_by')}</th>
          </tr>
        </thead>
        <tbody>
          {[...areas.entries()].map(([area, list]) => [
            <tr key={`area-${area}`}>
              <td
                colSpan={4}
                className="bg-(--bd-bg) font-mono text-[11.5px] font-semibold text-ink-500"
              >
                {area}.*
                <span className="ml-1.5 font-sans font-medium text-ink-400">{list.length}</span>
              </td>
            </tr>,
            ...list.map((p) => (
              <tr
                key={p.key}
                id={`permission-${p.key}`}
                className={cn(highlight === p.key && '[&>td]:bg-(--bd-primary-50)')}
              >
                <td className="font-mono text-[13px] font-semibold whitespace-nowrap text-ink-900">
                  {p.key}
                  {p.retired ? (
                    <span className="ml-2 rounded-full bg-(--bd-border-soft) px-2 py-0.5 font-sans text-[11px] font-semibold text-ink-500">
                      {t('retired')}
                    </span>
                  ) : null}
                </td>
                <td className="max-w-[520px] text-ink-700">{p.description}</td>
                <td>
                  {p.personal_data ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2.5 py-0.5 text-[12px] font-bold text-rose-700">
                      ● {t('yes')}
                    </span>
                  ) : (
                    <span className="text-[13px] text-ink-400">{t('no')}</span>
                  )}
                </td>
                <td>
                  <div className="flex flex-wrap gap-1.5">
                    {p.granted_by_roles.length ? (
                      p.granted_by_roles.map((k) => (
                        <button
                          key={k}
                          type="button"
                          onClick={() => onRole(k)}
                          className="rounded-md border border-transparent bg-(--bd-border-soft) px-2 py-0.5 text-[12.5px] font-medium text-ink-700 hover:border-(--bd-primary-100) hover:bg-(--bd-primary-50) hover:text-(--bd-primary-600)"
                        >
                          {nameOf(k)}
                        </button>
                      ))
                    ) : (
                      <span className="inline-flex items-center gap-1.5 rounded-md bg-amber-50 px-2 py-0.5 text-[12.5px] font-semibold text-amber-700">
                        <CircleAlert size={13} aria-hidden="true" />
                        {t('granted_by_none')}
                      </span>
                    )}
                  </div>
                </td>
              </tr>
            )),
          ])}
        </tbody>
      </table>
    </div>
  );
}

/** Which role grants which permission, at a glance. */
function MatrixView({
  roles,
  rows,
}: Readonly<{ roles: CatalogueRole[]; rows: CataloguePermission[] }>) {
  const t = useTranslations('console.access');
  if (roles.length === 0 || rows.length === 0) return <Empty>{t('matrix_empty')}</Empty>;
  const areas = new Map<string, CataloguePermission[]>();
  for (const p of rows) areas.set(areaOf(p.key), [...(areas.get(areaOf(p.key)) ?? []), p]);
  const sticky = 'sticky left-0 z-[1] bg-(--bd-card)';
  return (
    <div className="bd-card bd-shadow max-h-[70vh] overflow-auto">
      <table className="bd-table">
        <thead className="sticky top-0 z-[2]">
          <tr>
            <th className={cn(sticky, 'bg-(--bd-table-head-bg)')}>{t('col_permission')}</th>
            {roles.map((r) => (
              <th key={r.key} className="min-w-[110px] text-center tracking-normal! normal-case!">
                <span className="block text-[13px] font-bold text-ink-900">{r.name}</span>
                <span className="block text-[11.5px] font-medium text-ink-500">
                  {r.granted.via === 'assignment' ? t('via_assigned') : t('via_automatic')}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...areas.entries()].map(([area, list]) => [
            <tr key={`area-${area}`}>
              <td colSpan={roles.length + 1} className="bg-(--bd-bg) py-2!">
                <span className="sticky left-[14px] text-[11.5px] font-bold tracking-[0.08em] text-ink-500 uppercase">
                  {areaLabel(area)}
                </span>
              </td>
            </tr>,
            ...list.map((p) => (
              <tr key={p.key} className="group">
                <td className={cn(sticky, 'min-w-[260px] group-hover:bg-(--bd-table-head-bg)')}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-ink-900">{p.description || p.key}</span>
                    {p.personal_data ? (
                      <span className="rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-bold text-rose-700">
                        {t('personal_data')}
                      </span>
                    ) : null}
                  </div>
                  <div className="font-mono text-[11.5px] text-ink-400">{p.key}</div>
                </td>
                {roles.map((r) => (
                  <td key={r.key} className="text-center" title={`${r.name} · ${p.description}`}>
                    {r.permissions.includes(p.key) ? (
                      <span
                        className={cn(
                          'inline-grid h-[22px] w-[22px] place-items-center rounded-md',
                          p.personal_data
                            ? 'bg-rose-50 text-rose-600'
                            : 'bg-emerald-50 text-emerald-600',
                        )}
                      >
                        <Check size={13} strokeWidth={3} aria-label={t('yes')} />
                      </span>
                    ) : (
                      <span className="text-ink-300" aria-label={t('no')}>
                        —
                      </span>
                    )}
                  </td>
                ))}
              </tr>
            )),
          ])}
        </tbody>
        <tfoot className="sticky bottom-0 z-[2]">
          <tr>
            <td
              className={cn(
                sticky,
                'border-t border-(--bd-border) bg-(--bd-bg) px-[14px] py-3 text-[12.5px] font-bold text-ink-700',
              )}
            >
              {t('total')}
            </td>
            {roles.map((r) => (
              <td
                key={r.key}
                className="border-t border-(--bd-border) bg-(--bd-bg) px-[14px] py-3 text-center text-[13px] font-bold text-ink-900"
              >
                {r.permissions.length}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** A permission area as a heading: `profiles` becomes "Profiles". */
function areaLabel(area: string): string {
  return area.charAt(0).toUpperCase() + area.slice(1).replaceAll('_', ' ');
}

/** A plain empty or no-match message. */
function Empty({ children }: Readonly<{ children: ReactNode }>) {
  return <div className="bd-card bd-shadow px-6 py-12 text-center text-ink-500">{children}</div>;
}
