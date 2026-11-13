'use client';

import {
  useEffect,
  useLayoutEffect,
  useState,
  useRef,
  useMemo,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations, useLocale } from 'next-intl';
import { Button } from '../../../components/ui/Button';
import { StatusPill } from '../../../components/ui/StatusPill';
import { Avatar } from '../../../components/ui/Avatar';
import { Topbar } from '../../../components/shell/Topbar';
import { I, type IconName } from '../../../icons';
import { useDashboard } from '../../../hooks/useDashboard';
import { useAggregatorConfig, DEFAULT_AGGREGATOR_CONFIG } from '../../../hooks/useAggregatorConfig';
import { dashboardService, type LifecycleFilter } from '../../../services/dashboard.service';
import { mapDirectional } from '../../../services/row-mapping';
import { resolveTiles } from '../../../services/tiles';
import { DASHBOARD_BULK_ACTIONS, type BulkAction } from '../../../services/bulk-actions';
import { useCan } from '../../../lib/auth-context';
import type { DashboardTileDef } from '../../../hooks/useAggregatorConfig';
import { useProfileRaw } from '../../../hooks/useProfile';
import { useThemeMode } from '../../../lib/theme-mode';
import type {
  DirectionalStats,
  LifecycleStatus,
  ParticipantBase,
  ParticipantStatus,
  Provider,
  Seeker,
} from '../../../types';

/**
 * Indexes a domain's `status_rules` by status key for the status cards.
 *
 * @param rules - The active domain's `status_rules` from network config.
 * @returns Map of status key to its optional label/description copy.
 */
function indexStatusRules(
  rules: { status: string; label?: string; description?: string }[] | undefined,
): Record<string, { label?: string; description?: string }> {
  const out: Record<string, { label?: string; description?: string }> = {};
  for (const r of rules ?? []) {
    out[r.status] = {
      ...(r.label !== undefined ? { label: r.label } : {}),
      ...(r.description !== undefined ? { description: r.description } : {}),
    };
  }
  return out;
}

type StatTone = 'new' | 'active' | 'risk' | 'inactive' | 'satisfied';

interface ToneConfig {
  ring: string;
  bg: string;
  icon: string;
  num: string;
}

interface ToneNumColors {
  light: string;
  dark: string;
}
type StatToneConfig = Omit<ToneConfig, 'num'> & { num: ToneNumColors };

const STAT_TONES: Record<StatTone, StatToneConfig> = {
  new: {
    ring: '#6EE7B7',
    bg: 'linear-gradient(180deg,var(--bd-tint-emerald) 0%,var(--bd-card) 70%)',
    icon: '#059669',
    num: { light: '#065F46', dark: '#6EE7B7' },
  },
  active: {
    ring: '#A7F3D0',
    bg: 'linear-gradient(180deg,var(--bd-tint-emerald) 0%,var(--bd-card) 70%)',
    icon: '#10B981',
    num: { light: '#047857', dark: '#34D399' },
  },
  risk: {
    ring: '#FCD34D',
    bg: 'linear-gradient(180deg,var(--bd-tint-amber) 0%,var(--bd-card) 70%)',
    icon: '#F59E0B',
    num: { light: '#B45309', dark: '#FBBF24' },
  },
  inactive: {
    ring: '#FCA5A5',
    bg: 'linear-gradient(180deg,var(--bd-tint-rose) 0%,var(--bd-card) 70%)',
    icon: '#EF4444',
    num: { light: '#B91C1C', dark: '#F87171' },
  },
  satisfied: {
    ring: '#C7D2FE',
    bg: 'linear-gradient(180deg,var(--bd-tint-primary) 0%,var(--bd-card) 70%)',
    icon: '#6366F1',
    num: { light: '#4338CA', dark: '#A5B4FC' },
  },
};

interface StatCardProps {
  tone: StatTone;
  count: string;
  label: string;
  icon: IconName;
  hint?: string;
  action?: ReactNode;
}

function StatCard({ tone, count, label, icon, hint, action }: StatCardProps) {
  const t = STAT_TONES[tone] ?? STAT_TONES.inactive;
  const { mode } = useThemeMode();
  const Ic = I[icon];
  const numColor = mode === 'dark' ? t.num.dark : t.num.light;
  return (
    <div
      className="bd-card bd-shadow p-5 flex flex-col relative overflow-hidden transition-transform hover:-translate-y-0.5"
      style={{ background: t.bg }}
    >
      <div className="flex items-center justify-between mb-3.5">
        <div
          className="w-9 h-9 rounded-[10px] flex items-center justify-center"
          style={{ background: 'var(--bd-card)', border: `1px solid ${t.ring}`, color: t.icon }}
        >
          <Ic size={18} />
        </div>
        {action}
      </div>
      <div
        className="font-display font-bold text-[32px] leading-none tracking-tight"
        style={{ color: numColor }}
      >
        {count}
      </div>
      <div className="text-[15px] font-bold text-ink-900 mt-2.5">{label}</div>
      {hint && <div className="text-[12.5px] text-ink-500 mt-1 font-medium">{hint}</div>}
    </div>
  );
}

type DeltaTone = 'up' | 'down' | 'flat';

interface MiniStatProps {
  label: string;
  value: string;
  /** Optional leading icon rendered in a soft square next to the label. */
  icon?: IconName | undefined;
  /** Optional context line under the value (e.g. "50% of all profiles"). */
  sub?: string | undefined;
  delta?: string;
  deltaTone?: DeltaTone;
}

const DELTA_TONES: Record<DeltaTone, string> = {
  up: 'text-emerald-600 bg-emerald-50',
  down: 'text-rose-600 bg-rose-50',
  flat: 'text-ink-500 bg-ink-100',
};

function MiniStat({ label, value, icon, sub, delta, deltaTone = 'flat' }: MiniStatProps) {
  const Ic = icon ? I[icon] : null;
  return (
    <div className="bd-card p-4 flex flex-col gap-2.5 transition-transform hover:-translate-y-0.5">
      <div className="flex items-center gap-2.5">
        {Ic && (
          <div className="w-8 h-8 rounded-[9px] bg-ink-50 text-ink-500 flex items-center justify-center shrink-0">
            <Ic size={16} />
          </div>
        )}
        <div className="text-[13px] text-ink-500 font-semibold">{label}</div>
      </div>
      {/* mt-auto keeps values aligned across a row when labels wrap. */}
      <div className="mt-auto flex flex-col gap-1">
        <div className="flex items-baseline gap-2">
          <div className="font-display font-bold text-[26px] text-ink-900 leading-none tracking-tight">
            {value}
          </div>
          {delta && (
            <span
              className={`text-[11px] font-semibold px-1.5 py-0.5 rounded-md ${DELTA_TONES[deltaTone]}`}
            >
              {delta}
            </span>
          )}
        </div>
        {/* min-h keeps values aligned when a tile has no sub-line. */}
        <div className="text-[12px] text-ink-400 font-medium min-h-[18px]">{sub}</div>
      </div>
    </div>
  );
}

/**
 * Domain summary bar above the lifecycle funnel.
 *
 * Shows the domain's `plural_label`, the live total, a hint, and the refresh action.
 */
function SummaryBar({
  icon,
  label,
  total,
  refreshing,
  refreshError,
  lastRefreshedAt,
  onRefresh,
}: {
  icon: IconName;
  label: string;
  total: number | undefined;
  refreshing: boolean;
  refreshError: string | null;
  lastRefreshedAt: number | null;
  onRefresh: () => void;
}) {
  const t = useTranslations('dashboard');
  const Ic = I[icon];
  return (
    <div className="bd-card bd-shadow px-5 py-4 flex flex-wrap items-center gap-4">
      <div
        className="w-11 h-11 rounded-[12px] flex items-center justify-center shrink-0"
        style={{ background: 'var(--bd-primary-50)', color: 'var(--bd-primary-600)' }}
      >
        <Ic size={22} />
      </div>
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-[11.5px] font-bold uppercase tracking-[.06em] text-ink-400 truncate">
          {label}
        </span>
        <span className="font-display font-bold text-[18px] text-ink-900 leading-tight">
          {t('summary.total', { count: fmtCount(total) })}
        </span>
      </div>
      <div className="w-px self-stretch bg-(--bd-border) mx-1 hidden sm:block" />
      <span className="text-[13px] text-ink-500 font-medium hidden sm:block">
        {t('summary.hint')}
      </span>
      <div className="ml-auto flex items-center gap-2">
        {refreshError ? (
          <span className="max-w-[220px] truncate text-xs text-red-600" title={refreshError}>
            {t('state.refreshFailed')}
          </span>
        ) : lastRefreshedAt !== null && Date.now() - lastRefreshedAt < 5000 ? (
          <span className="text-xs text-ink-400">{t('state.refreshedJustNow')}</span>
        ) : null}
        <Button
          kind="ghost"
          icon={
            <I.refresh
              size={14}
              className={refreshing ? 'animate-spin' : undefined}
              aria-hidden="true"
            />
          }
          onClick={onRefresh}
          disabled={refreshing}
          aria-label={t('aria.refresh')}
          title={t('aria.refresh')}
        >
          {refreshing ? t('buttons.refreshing') : t('buttons.refresh')}
        </Button>
      </div>
    </div>
  );
}

/**
 * Labelled metric group: a heading over a responsive card grid.
 *
 * Used for the "Profiles" and "Users" sections.
 */
function MetricGroup({ title, children }: { title: string; children: ReactNode }) {
  // h-full + flex-1 keep side-by-side groups the same height.
  return (
    <div className="flex h-full flex-col">
      <div className="text-[11.5px] font-bold uppercase tracking-[.09em] text-ink-400 mb-3">
        {title}
      </div>
      <div className="grid flex-1 grid-cols-1 sm:grid-cols-3 gap-4">{children}</div>
    </div>
  );
}

/** Icon per known rollup tile field. Unknown fields have no icon. */
const TILE_ICONS: Record<string, IconName> = {
  total_items: 'copy',
  complete_profiles: 'check',
  has_applications: 'send',
  total_users: 'users',
  avg_items_per_user: 'trending',
  avg_actions_per_user: 'spark',
};

/**
 * Returns the sub-line for a known rollup tile field.
 *
 * Returns undefined for unknown fields, and for the completion share when a
 * count is missing or the total is 0.
 *
 * @param field - The tile's rollup field name.
 * @param t - Dashboard-scoped translator.
 * @param entityPlural - Active domain's plural label for interpolation.
 * @param rollup - Domain rollup, used to derive the completion share.
 */
function tileSub(
  field: string,
  t: ReturnType<typeof useTranslations>,
  entityPlural: string,
  rollup: { total_items: number; complete_profiles: number } | undefined,
): string | undefined {
  switch (field) {
    case 'total_items':
      return t('ministat.sub_total', { entityPlural });
    case 'complete_profiles': {
      if (!rollup || rollup.total_items <= 0) return undefined;
      return t('ministat.sub_complete', {
        pct: Math.round((rollup.complete_profiles / rollup.total_items) * 100),
      });
    }
    case 'has_applications':
      return t('ministat.sub_applications');
    case 'total_users':
      return t('ministat.sub_totalUsers');
    case 'avg_items_per_user':
      return t('ministat.sub_avgItems');
    case 'avg_actions_per_user':
      return t('ministat.sub_avgActions');
    default:
      return undefined;
  }
}

interface FunnelPart {
  v: number;
  color: string;
  label: string;
  short: string;
}

interface FunnelCellProps {
  total: number;
  parts: FunnelPart[];
}

/** Minimum distance (px) kept between a cell popover and the viewport edge. */
const POPOVER_GUTTER = 8;

/** How far (px) a cell may move before a scroll event closes the popover. */
const POPOVER_SCROLL_TOLERANCE = 2;

/**
 * Open and position state for the portal popovers on table cells (FunnelCell, ProgressTiny).
 *
 * Opens on hover for mouse, on tap for touch, and on focus for keyboard;
 * Escape closes it. A layout effect places it beside its cell, at least
 * {@link POPOVER_GUTTER} from the viewport edge, before paint. A scroll closes
 * it only when the cell moved.
 *
 * @returns The trigger ref, the popover ref, open flag, page-relative position
 *   and the props to spread onto the trigger element.
 */
function useCellPopover() {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number; placed: boolean }>({
    x: 0,
    y: 0,
    placed: false,
  });
  const ref = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  // Viewport position of the cell when the popover opened (scroll-move check).
  const anchorRef = useRef<{ left: number; top: number } | null>(null);

  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    anchorRef.current = { left: r.left, top: r.top };
    setPos({ x: window.scrollX, y: r.bottom + window.scrollY + 8, placed: false });
    setOpen(true);
  };
  const hide = () => setOpen(false);

  useLayoutEffect(() => {
    if (!open || pos.placed) return;
    const trigger = ref.current?.getBoundingClientRect();
    const popover = popoverRef.current?.getBoundingClientRect();
    if (!trigger || !popover) return;
    const maxLeft = Math.max(POPOVER_GUTTER, window.innerWidth - popover.width - POPOVER_GUTTER);
    const left = Math.min(Math.max(trigger.left, POPOVER_GUTTER), maxLeft);
    setPos((p) => ({ ...p, x: left + window.scrollX, placed: true }));
  }, [open, pos.placed]);

  // Close on a scroll that moves the cell. Capture phase also catches element scrolls.
  useEffect(() => {
    if (!open) return;
    const onScroll = () => {
      const r = ref.current?.getBoundingClientRect();
      const a = anchorRef.current;
      if (
        !r ||
        !a ||
        Math.abs(r.left - a.left) > POPOVER_SCROLL_TOLERANCE ||
        Math.abs(r.top - a.top) > POPOVER_SCROLL_TOLERANCE
      ) {
        setOpen(false);
      }
    };
    window.addEventListener('scroll', onScroll, true);
    return () => window.removeEventListener('scroll', onScroll, true);
  }, [open]);

  const triggerProps = {
    tabIndex: 0,
    onPointerEnter: (e: ReactPointerEvent) => {
      if (e.pointerType === 'mouse') show();
    },
    onPointerLeave: (e: ReactPointerEvent) => {
      if (e.pointerType === 'mouse') hide();
    },
    onClick: (e: ReactMouseEvent) => {
      // Mouse opened it on hover; a click must not close it.
      if ((e.nativeEvent as PointerEvent).pointerType === 'mouse') return;
      if (open) hide();
      else show();
    },
    onFocus: (e: ReactFocusEvent<HTMLDivElement>) => {
      // Only keyboard focus opens it; a tap opens it through the click.
      if (e.currentTarget.matches(':focus-visible')) show();
    },
    onBlur: hide,
    onKeyDown: (e: ReactKeyboardEvent) => {
      if (e.key === 'Escape') hide();
    },
  };

  return { ref, popoverRef, open, pos, triggerProps };
}

function FunnelCell({ total, parts }: FunnelCellProps) {
  const sum = parts.reduce((a, b) => a + b.v, 0) || 1;
  const { ref, popoverRef, open: hover, pos, triggerProps } = useCellPopover();

  return (
    <>
      <div
        ref={ref}
        {...triggerProps}
        className="inline-flex items-center gap-2 cursor-default rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--bd-primary)"
      >
        <span className="font-display font-bold text-[18px] text-ink-900 tabular-nums leading-none">
          {total}
        </span>
        <div className="flex h-1 w-16 rounded-full overflow-hidden bg-ink-100">
          {parts.map((p, i) => (
            <div key={i} style={{ width: `${(p.v / sum) * 100}%`, background: p.color }} />
          ))}
        </div>
      </div>

      {hover &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={popoverRef}
            data-cell-popover=""
            style={{ position: 'absolute', left: pos.x, top: pos.y, zIndex: 9999 }}
            // max-w + wrap-anywhere keep the popover within the viewport.
            className="bg-white border border-(--bd-border) rounded-[10px] bd-shadow-lg p-2.5 min-w-[160px] max-w-[calc(100vw-1rem)] wrap-anywhere pointer-events-none animate-[fadeUp_.12s_ease-out]"
          >
            <div className="flex flex-col gap-1.5">
              {parts.map((p, i) => (
                <div key={i} className="flex items-center gap-2 text-[12px]">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: p.color }} />
                  <span className="text-ink-500 flex-1">{p.label}</span>
                  <span className="font-semibold tabular-nums text-ink-900">{p.v}</span>
                </div>
              ))}
              <div className="border-t border-(--bd-border-soft) mt-1 pt-1.5 flex items-center gap-2 text-[12px]">
                <span className="text-ink-400 flex-1">Total</span>
                <span className="font-display font-bold tabular-nums text-ink-900">{total}</span>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * Profile-completion progress bar from `profile_completion_pct`.
 *
 * Hovering shows a popover with the lifecycle label passed in `title`.
 */
function ProgressTiny({ pct, title }: { pct: number; title?: string }) {
  const color = pct >= 80 ? '#10B981' : pct >= 50 ? '#F59E0B' : '#EF4444';
  const label = title ?? (pct >= 80 ? 'Complete' : 'Incomplete');
  const { ref, popoverRef, open: hover, pos, triggerProps } = useCellPopover();
  return (
    <>
      <div
        ref={ref}
        {...triggerProps}
        className="flex items-center gap-2 cursor-default rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--bd-primary)"
      >
        <div
          role="progressbar"
          aria-label={label}
          aria-valuenow={Math.round(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
          className="w-14 h-1.5 rounded-full bg-ink-100 overflow-hidden"
        >
          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
        </div>
        <span className="text-[11px] tabular-nums text-ink-500 font-medium">{pct}%</span>
      </div>
      {hover &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={popoverRef}
            data-cell-popover=""
            style={{ position: 'absolute', left: pos.x, top: pos.y, zIndex: 9999 }}
            className="bg-white border border-(--bd-border) rounded-[10px] bd-shadow-lg px-2.5 py-1.5 max-w-[calc(100vw-1rem)] wrap-anywhere pointer-events-none animate-[fadeUp_.12s_ease-out]"
          >
            <div className="flex items-center gap-2 text-[12px] min-w-[120px]">
              <span className="text-ink-500 flex-1">{label}</span>
              <span className="font-semibold tabular-nums text-ink-900">{pct}%</span>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

type RowKind = 'seeker' | 'provider' | 'opp';

type StatusFilter = string; // 'all' | any key signalstack returns in rollup.by_status

/**
 * Lifecycle dropdown values.
 *
 * `'all'` means no filter; the others map to {@link LifecycleFilter} on the items endpoint.
 */
type LifecycleFilterValue = 'all' | LifecycleFilter;

// Lifecycle states shown: `draft` (<100% complete) and `live` (100%). A new
// status needs an entry here, a dropdown <option>, and a `filters.lifecycle_<x>` key.
const LIFECYCLE_FILTER_VALUES: LifecycleFilterValue[] = ['all', 'draft', 'live'];

/** Parses `?lifecycle=` from search params. Unknown values resolve to `'all'`. */
function parseLifecycleParam(raw: string | null): LifecycleFilterValue {
  if (!raw) return 'all';
  return (LIFECYCLE_FILTER_VALUES as readonly string[]).includes(raw)
    ? (raw as LifecycleFilterValue)
    : 'all';
}

interface StatusOption {
  value: StatusFilter;
  label: string;
  count?: number;
}

/** Converts a snake_case or kebab-case status key to a Title Case label. */
function statusLabel(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => (w.length ? w[0]!.toUpperCase() + w.slice(1) : ''))
    .join(' ');
}

function buildStatusOptions(
  byStatus: Record<string, number> | undefined,
  allLabel: string,
): StatusOption[] {
  const opts: StatusOption[] = [{ value: 'all', label: allLabel }];
  if (!byStatus) return opts;
  for (const [key, count] of Object.entries(byStatus)) {
    if (!key) continue;
    opts.push({ value: key, label: statusLabel(key), count });
  }
  return opts;
}

/**
 * Looks up a bucket label from config, then the fallback, then the raw key.
 *
 * @param labels - Bucket label map from config.
 * @param key - Bucket key (e.g. `'create'`, `'accept'`).
 * @param getFallback - Optional function that returns the localised fallback label for the key.
 * @returns The resolved label string.
 */
function getBucketLabel(
  labels: Record<string, string>,
  key: string,
  getFallback?: (k: string) => string,
): string {
  return labels[key] ?? getFallback?.(key) ?? key;
}

/**
 * Builds the create/accept/reject/cancel funnel parts for one direction of a row's action counts.
 *
 * @param stats - The directional counts for the row.
 * @param labels - Config-sourced bucket labels for this direction.
 * @param fallback - Localised fallback label supplier.
 */
function buildActionParts(
  stats: DirectionalStats,
  labels: Record<string, string>,
  fallback: (k: string) => string,
): Array<{ v: number; color: string; label: string; short: string }> {
  const part = (key: keyof DirectionalStats, color: string) => ({
    v: stats[key],
    color,
    label: getBucketLabel(labels, key, fallback),
    short: getBucketLabel(labels, key, fallback),
  });
  return [
    part('create', 'var(--bd-funnel-requested)'),
    part('accept', 'var(--bd-funnel-connected)'),
    part('reject', 'var(--bd-funnel-declined)'),
    part('cancel', 'var(--bd-funnel-cancelled)'),
  ];
}

/**
 * Default tile groups, used when network config has no `dashboard_tiles.profile`
 * or `dashboard_tiles.user`.
 */
function useDefaultTiles(entityPlural: string): {
  profile: DashboardTileDef[];
  user: DashboardTileDef[];
} {
  const t = useTranslations('dashboard');
  return useMemo(
    () => ({
      profile: [
        { field: 'total_items', label: t('ministat.totalItems', { entityPlural }) },
        { field: 'complete_profiles', label: t('ministat.completeProfiles') },
        { field: 'has_applications', label: t('ministat.withApplications', { entityPlural }) },
      ],
      user: [
        { field: 'total_users', label: t('ministat.totalUsers') },
        { field: 'avg_items_per_user', label: t('ministat.avgProfilesPerUser') },
        { field: 'avg_actions_per_user', label: t('ministat.avgActionsPerUser') },
      ],
    }),
    [t, entityPlural],
  );
}

/**
 * Action bar shown above the table while rows are selected.
 *
 * Renders one button per {@link BulkAction} in `DASHBOARD_BULK_ACTIONS`.
 */
function BulkActionBar({
  selectedRows,
  domain,
  onClear,
}: {
  selectedRows: ParticipantBase[];
  domain: string;
  onClear: () => void;
}) {
  const t = useTranslations('dashboard');
  const can = useCan();
  const [runningId, setRunningId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const noticeTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    },
    [],
  );

  const runAction = async (action: BulkAction) => {
    if (runningId) return;
    setRunningId(action.id);
    setNotice(null);
    try {
      await action.run(selectedRows, { domain });
      setNotice({ kind: 'success', text: t('bulk.success', { count: selectedRows.length }) });
    } catch (err) {
      setNotice({
        kind: 'error',
        text: err instanceof Error ? err.message : t('bulk.failed'),
      });
    } finally {
      setRunningId(null);
      if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
      noticeTimer.current = window.setTimeout(() => setNotice(null), 4000);
    }
  };

  return (
    <div className="px-5 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-(--bd-border) bg-(--bd-primary-50)">
      <span className="text-[12.5px] font-semibold text-primary-600 whitespace-nowrap">
        {t('bulk.selected', { count: selectedRows.length })}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        {DASHBOARD_BULK_ACTIONS.filter((a) => can(a.capability)).map((a) => {
          const Ic = I[a.icon];
          return (
            <Button
              key={a.id}
              kind="ghost"
              icon={<Ic size={13} />}
              onClick={() => void runAction(a)}
              disabled={runningId !== null}
              className="whitespace-nowrap px-3 py-1.5 text-[12.5px]"
            >
              {runningId === a.id ? t('bulk.running') : t(a.labelKey)}
            </Button>
          );
        })}
      </div>
      {notice && (
        <span
          aria-live="polite"
          className={`text-[12px] font-medium truncate ${
            notice.kind === 'success' ? 'text-emerald-700' : 'text-rose-600'
          }`}
        >
          {notice.text}
        </span>
      )}
      <button
        type="button"
        onClick={onClear}
        className="ml-auto text-[12px] font-semibold text-ink-500 hover:text-ink-700 whitespace-nowrap"
      >
        {t('bulk.clear')}
      </button>
    </div>
  );
}

interface ParticipantTableProps<R extends ParticipantBase> {
  kind: RowKind;
  /** Domain id for this table, from network config. Defaults from `kind` when omitted. */
  domain?: string | undefined;
  rows: R[];
  /** Total from signalstack `total_matching`, used for pagination. */
  total?: number | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
  onPageChange?: ((next: number) => void) | undefined;
  /** Server-side status filter. `'all'` sends no `?status=`. */
  statusFilter?: StatusFilter | undefined;
  onStatusFilterChange?: ((next: StatusFilter) => void) | undefined;
  /** Statuses for this domain, from `rollup.by_status`. */
  statusOptions?: StatusOption[] | undefined;
  /** Initiated-column bucket labels from config; falls back to `t('buckets.*')`. */
  initiatedLabels?: Record<string, string> | undefined;
  /** Received-column bucket labels from config; falls back to `t('buckets.*')`. */
  receivedLabels?: Record<string, string> | undefined;
  /** Active lifecycle dropdown value. `'all'` hides the URL param. */
  lifecycleFilter?: LifecycleFilterValue | undefined;
  onLifecycleFilterChange?: ((next: LifecycleFilterValue) => void) | undefined;
  /**
   * Fetches every row matching the current filter in one call.
   *
   * Omit to hide the "Select all N matching" banner.
   */
  onSelectAllMatching?: (() => Promise<R[]>) | undefined;
}

function ParticipantTable<R extends ParticipantBase>({
  kind,
  domain,
  rows,
  total,
  page = 1,
  pageSize = 25,
  onPageChange,
  statusFilter = 'all',
  onStatusFilterChange,
  statusOptions,
  initiatedLabels = {},
  receivedLabels = {},
  lifecycleFilter = 'all',
  onLifecycleFilterChange,
  onSelectAllMatching,
}: ParticipantTableProps<R>) {
  const t = useTranslations('dashboard');
  const { data: tableCfg = DEFAULT_AGGREGATOR_CONFIG } = useAggregatorConfig();
  // Heading entity label from the network config's singular `label`.
  const headingEntity =
    tableCfg.domains?.find((d) => d.id === domain)?.label ??
    (kind === 'provider' ? t('table.provider') : t('table.participant'));
  /** Localised fallback for bucket keys when config-sourced labels are absent. */
  const getBucketFallback = (key: string): string => {
    const map: Record<string, string> = {
      create: t('buckets.created'),
      accept: t('buckets.accepted'),
      reject: t('buckets.rejected'),
      cancel: t('buckets.cancelled'),
    };
    return map[key] ?? key;
  };
  const options: StatusOption[] = statusOptions ?? [
    { value: 'all', label: t('filters.all_statuses') },
  ];
  const searchId = `bd-search-${kind}`;
  const [query, setQuery] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement | null>(null);

  // Close the filter popover on outside `mousedown`.
  useEffect(() => {
    if (!filterOpen) return;
    const handler = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setFilterOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [filterOpen]);

  // Client-side search; filters the current page only.
  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      const hay = [r.name, r.id, r.city, (r as unknown as Provider).role ?? '']
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [rows, query]);

  const filterActive = statusFilter !== 'all';

  // Domain id for bulk actions. Falls back to `kind` when no domain is passed.
  const bulkDomain: string = domain ?? (kind === 'seeker' ? 'seeker' : 'provider');

  // Selected rows, stored as full row data so actions like CSV export work
  // across pages. Kept across page changes; reset when a filter changes.
  const [selected, setSelected] = useState<Map<string, ParticipantBase>>(new Map());
  // True after "Select all N matching" selected every matching row.
  const [selectedAllMatching, setSelectedAllMatching] = useState(false);
  // In-flight guard while the fetch-all-matching call runs.
  const [selectingAll, setSelectingAll] = useState(false);
  useEffect(() => {
    setSelected(new Map());
    setSelectedAllMatching(false);
  }, [statusFilter, lifecycleFilter]);

  // Rows with synthetic `row-<index>` keys are not selectable.
  const isSelectable = (r: ParticipantBase): boolean => !r.id.startsWith('row-');
  const selectablePageRows = visibleRows.filter(isSelectable);
  const allPageSelected =
    selectablePageRows.length > 0 && selectablePageRows.every((r) => selected.has(r.id));

  const toggleRow = (r: ParticipantBase) => {
    // Any single change ends "all matching" mode.
    setSelectedAllMatching(false);
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(r.id)) next.delete(r.id);
      else next.set(r.id, r);
      return next;
    });
  };

  /**
   * Header checkbox toggle.
   *
   * Clears the selection if any rows are selected; otherwise selects the current page.
   */
  const togglePage = () => {
    setSelectedAllMatching(false);
    if (selected.size > 0) {
      setSelected(new Map());
      return;
    }
    setSelected((prev) => {
      const next = new Map(prev);
      for (const r of selectablePageRows) next.set(r.id, r);
      return next;
    });
  };

  const clearSelection = () => {
    setSelectedAllMatching(false);
    setSelected(new Map());
  };

  /** Fetches every matching row and selects all selectable ones. */
  const selectAllMatching = async () => {
    if (!onSelectAllMatching || selectingAll) return;
    setSelectingAll(true);
    try {
      const allRows = await onSelectAllMatching();
      setSelected(() => {
        const next = new Map<string, ParticipantBase>();
        for (const r of allRows) if (isSelectable(r)) next.set(r.id, r);
        return next;
      });
      setSelectedAllMatching(true);
    } finally {
      setSelectingAll(false);
    }
  };

  // Show "select all N matching" when the whole page is selected, more rows
  // exist, and the parent can fetch them.
  const showSelectAllMatching =
    !!onSelectAllMatching &&
    allPageSelected &&
    !selectedAllMatching &&
    typeof total === 'number' &&
    total > selectablePageRows.length;

  return (
    <div className="bd-card bd-shadow overflow-hidden">
      <div className="px-5 py-4 flex flex-wrap sm:flex-nowrap items-center gap-3 border-b border-(--bd-border)">
        <div className="font-display font-bold text-[15px] text-ink-900">
          {kind === 'opp'
            ? t('table.opportunityProviders')
            : `${headingEntity} ${t('table.activitySuffix')}`}
        </div>
        <span className="text-[12px] text-ink-400">
          {t('table.count', { shown: visibleRows.length, total: total ?? rows.length })}
        </span>

        {/* Below `sm` the controls wrap onto a full-width row with the filter
            button on the right. From `sm` up they stay on one row. */}
        <div className="w-full sm:w-auto sm:ml-auto flex flex-wrap sm:flex-nowrap items-center gap-2">
          <div className="relative basis-full sm:basis-auto">
            <label htmlFor={searchId} className="sr-only">
              {t('aria.search_participants')}
            </label>
            <I.search
              size={15}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400"
            />
            <input
              id={searchId}
              aria-label={t('aria.search_participants')}
              className="bd-input w-full sm:w-[360px] sm:shrink-0 text-[13px] py-1.5"
              style={{ paddingLeft: 36 }}
              placeholder={
                kind === 'seeker' ? t('search.seekerPlaceholder') : t('search.providerPlaceholder')
              }
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {onLifecycleFilterChange ? (
            <select
              aria-label={t('filters.lifecycle_label')}
              className="bd-input w-auto max-w-[150px] text-[12.5px] py-1.5 pr-7 flex-1 sm:flex-initial"
              value={lifecycleFilter}
              onChange={(e) => onLifecycleFilterChange(e.target.value as LifecycleFilterValue)}
            >
              <option value="all">{t('filters.lifecycle_all')}</option>
              <option value="draft">{t('filters.lifecycle_draft')}</option>
              <option value="live">{t('filters.lifecycle_live')}</option>
            </select>
          ) : null}
          <div ref={filterRef} className="relative ml-auto sm:ml-0">
            <Button
              kind={filterActive ? 'primary' : 'ghost'}
              icon={<I.filter size={14} />}
              onClick={() => setFilterOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={filterOpen}
              className="whitespace-nowrap px-3 py-1.5 text-[12.5px]"
            >
              {filterActive
                ? (options.find((o) => o.value === statusFilter)?.label ?? 'Filtered')
                : 'All filters'}
            </Button>
            {filterOpen && (
              <div
                role="menu"
                // Max height with its own scroll so every option stays reachable.
                className="absolute right-0 top-full mt-1 z-20 min-w-[180px] max-w-[calc(100vw-2rem)] max-h-[min(320px,60vh)] overflow-y-auto bg-white border border-(--bd-border) rounded-[10px] bd-shadow-lg p-1"
              >
                {options.map((opt) => {
                  const active = statusFilter === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      onClick={() => {
                        onStatusFilterChange?.(opt.value);
                        setFilterOpen(false);
                      }}
                      className={`w-full text-left px-2.5 py-1.5 rounded-md text-[12.5px] flex items-center justify-between ${
                        active
                          ? 'bg-(--bd-primary-50) text-primary-600 font-semibold'
                          : 'text-ink-700 hover:bg-ink-50'
                      }`}
                    >
                      <span>{opt.label}</span>
                      {opt.count !== undefined ? (
                        <span className="text-[11px] tabular-nums text-ink-400">{opt.count}</span>
                      ) : active ? (
                        <I.check size={12} />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {selected.size > 0 && (
        <BulkActionBar
          selectedRows={[...selected.values()]}
          domain={bulkDomain}
          onClear={clearSelection}
        />
      )}

      {/* Banner to extend the selection to every matching row. */}
      {(showSelectAllMatching || selectedAllMatching) && (
        <div className="px-5 py-2 flex items-center justify-center gap-2 border-b border-(--bd-border) bg-(--bd-primary-50) text-[12.5px] text-ink-600">
          {selectedAllMatching ? (
            <>
              <span>{t('bulk.allMatchingSelected', { count: selected.size })}</span>
              <button
                type="button"
                onClick={clearSelection}
                className="font-semibold text-primary-600 hover:underline"
              >
                {t('bulk.clearSelection')}
              </button>
            </>
          ) : (
            <>
              <span>{t('bulk.allPageSelected', { count: selectablePageRows.length })}</span>
              <button
                type="button"
                onClick={() => void selectAllMatching()}
                disabled={selectingAll}
                className="font-semibold text-primary-600 hover:underline disabled:opacity-50"
              >
                {selectingAll
                  ? t('bulk.selectingAll')
                  : t('bulk.selectAllMatching', { count: total ?? 0 })}
              </button>
            </>
          )}
        </div>
      )}

      <div className="overflow-auto scroll-x" style={{ maxHeight: 520 }}>
        <table className="bd-table" style={{ minWidth: (kind === 'provider' ? 1500 : 1400) + 44 }}>
          <thead
            style={{
              position: 'sticky',
              top: 0,
              zIndex: 4,
              background: 'var(--bd-table-head-bg)',
            }}
          >
            <tr>
              <th
                className="bd-sticky-col"
                style={{
                  zIndex: 5,
                  background: 'var(--bd-table-head-bg)',
                  width: 44,
                  minWidth: 44,
                }}
              >
                <input
                  type="checkbox"
                  className="w-4 h-4 cursor-pointer align-middle"
                  style={{ accentColor: 'var(--bd-primary-600)' }}
                  ref={(el) => {
                    // Indeterminate when a selection exists but this page is not fully selected.
                    if (el) el.indeterminate = selected.size > 0 && !allPageSelected;
                  }}
                  checked={allPageSelected}
                  onChange={togglePage}
                  disabled={selectablePageRows.length === 0 && selected.size === 0}
                  aria-label={t('aria.select_all_page')}
                />
              </th>
              <th
                className="bd-sticky-col bd-sticky-col-2"
                style={{
                  zIndex: 5,
                  background: 'var(--bd-table-head-bg)',
                  minWidth: 240,
                }}
              >
                {kind === 'seeker' ? t('table.participant') : t('table.provider')}
              </th>
              <th>{t('table.joined')}</th>
              <th>{t('table.profileStatus')}</th>
              <th>{t('table.initiated')}</th>
              <th>{t('table.received')}</th>
              <th>{t('table.status')}</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((r) => {
              return (
                <tr key={r.id} className="fade-up">
                  <td
                    className="bd-sticky-col"
                    style={{
                      background: 'inherit',
                      backgroundColor: 'var(--bd-card)',
                      zIndex: 1,
                      width: 44,
                    }}
                  >
                    {isSelectable(r) && (
                      <input
                        type="checkbox"
                        className="bd-check w-4 h-4 align-middle"
                        checked={selected.has(r.id)}
                        onChange={() => toggleRow(r)}
                        aria-label={t('aria.select_row', { name: r.name })}
                      />
                    )}
                  </td>
                  <td
                    className="bd-sticky-col bd-sticky-col-2"
                    style={{
                      background: 'inherit',
                      backgroundColor: 'var(--bd-card)',
                      zIndex: 1,
                    }}
                  >
                    <div className="flex items-center gap-3">
                      <Avatar initials={r.avatar} />
                      <div className="min-w-0">
                        <div className="font-semibold text-ink-900 text-[14px] truncate flex items-center gap-1.5">
                          {r.name}
                          {r.profile.verified && (
                            <I.shield size={13} className="text-emerald-500" />
                          )}
                        </div>
                        <div className="text-[12px] text-ink-400 flex items-center gap-1.5 mt-0.5">
                          <span className="font-mono">{r.id}</span>
                          <span className="text-ink-200">·</span>
                          <span>{r.city}</span>
                        </div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div className="text-[13px] text-ink-700">{r.joined}</div>
                    <div className="text-[11px] text-ink-400 mt-0.5">last seen {r.last}</div>
                  </td>
                  <td>
                    <ProgressTiny
                      pct={r.profile.complete}
                      title={
                        r.lifecycle_status === 'live'
                          ? t('filters.lifecycle_live')
                          : t('filters.lifecycle_draft')
                      }
                    />
                  </td>
                  <td>
                    <FunnelCell
                      total={
                        r.initiated.create +
                        r.initiated.accept +
                        r.initiated.reject +
                        r.initiated.cancel
                      }
                      parts={buildActionParts(r.initiated, initiatedLabels, getBucketFallback)}
                    />
                  </td>
                  <td>
                    <FunnelCell
                      total={
                        r.received.create +
                        r.received.accept +
                        r.received.reject +
                        r.received.cancel
                      }
                      parts={buildActionParts(r.received, receivedLabels, getBucketFallback)}
                    />
                  </td>
                  <td>
                    <StatusPill status={r.status} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <PaginationFooter
        page={page}
        pageSize={pageSize}
        total={total ?? rows.length}
        rowsOnPage={rows.length}
        onPageChange={onPageChange}
        searchActive={query.trim().length > 0}
        visibleCount={visibleRows.length}
      />
    </div>
  );
}

interface PaginationFooterProps {
  page: number;
  pageSize: number;
  total: number;
  rowsOnPage: number;
  onPageChange?: ((next: number) => void) | undefined;
  /** True while a search is active; hides page buttons and shows the filtered count. */
  searchActive?: boolean | undefined;
  visibleCount?: number | undefined;
}

/**
 * Table footer with the "Showing X–Y of Z" line.
 *
 * Page buttons appear only when there is more than one page.
 */
function PaginationFooter({
  page,
  pageSize,
  total,
  rowsOnPage,
  onPageChange,
  searchActive = false,
  visibleCount,
}: PaginationFooterProps) {
  const t = useTranslations('dashboard');
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = (page - 1) * pageSize + rowsOnPage;
  const canPrev = page > 1;
  const canNext = page < totalPages;
  // During a search, show the filtered count of the current page.
  const showSearchSummary = searchActive && visibleCount !== undefined;
  const change = (next: number) => {
    if (!onPageChange) return;
    if (next < 1 || next > totalPages || next === page) return;
    onPageChange(next);
  };
  // At most 7 page entries, with ellipsis.
  const pageList = buildPageList(page, totalPages);
  return (
    <div className="px-5 py-3 border-t border-(--bd-border) flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between text-[12.5px] text-ink-500">
      <div className="text-center sm:text-left">
        {showSearchSummary
          ? t('pagination.matching', { shown: visibleCount, rowsOnPage })
          : t('pagination.showing', { from: start, to: end, total })}
      </div>
      {totalPages > 1 && !searchActive && (
        <div className="flex flex-wrap items-center justify-center gap-1">
          <button
            type="button"
            aria-label={t('aria.prev_page')}
            disabled={!canPrev}
            onClick={() => change(page - 1)}
            className="px-2.5 py-1.5 rounded-md hover:bg-ink-100 text-ink-400 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
          >
            <I.chevL size={14} />
          </button>
          {pageList.map((p, i) =>
            p === '…' ? (
              <span key={`gap-${i}`} className="px-2 text-ink-300 select-none">
                …
              </span>
            ) : p === page ? (
              <button
                key={p}
                type="button"
                aria-current="page"
                className="px-3 py-1 rounded-md bg-(--bd-primary-50) text-primary-600 font-semibold"
              >
                {p}
              </button>
            ) : (
              <button
                key={p}
                type="button"
                onClick={() => change(p)}
                className="px-3 py-1 rounded-md hover:bg-ink-100"
              >
                {p}
              </button>
            ),
          )}
          <button
            type="button"
            aria-label={t('aria.next_page')}
            disabled={!canNext}
            onClick={() => change(page + 1)}
            className="px-2.5 py-1.5 rounded-md hover:bg-ink-100 text-ink-400 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
          >
            <I.chevR size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Returns the page button list with `…` markers.
 *
 * Up to 7 pages shows every number. Otherwise shows the first, last, current,
 * and the current page's neighbours.
 */
function buildPageList(current: number, totalPages: number): Array<number | '…'> {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const out: Array<number | '…'> = [1];
  const left = Math.max(2, current - 1);
  const right = Math.min(totalPages - 1, current + 1);
  if (left > 2) out.push('…');
  for (let p = left; p <= right; p++) out.push(p);
  if (right < totalPages - 1) out.push('…');
  out.push(totalPages);
  return out;
}

function LoadingCard() {
  const t = useTranslations('dashboard');
  return (
    <div className="bd-card bd-shadow p-8 text-[13px] text-ink-400" style={{ opacity: 0.6 }}>
      {t('state.loading')}
    </div>
  );
}

function ErrorCard() {
  const t = useTranslations('dashboard');
  return (
    <div className="bd-card bd-shadow p-8 text-[13px] text-rose-600">{t('state.failedToLoad')}</div>
  );
}

const PAGE_SIZE = 25;

/**
 * Lifecycle filter state stored in `?lifecycle=`.
 *
 * Updates the URL with `router.replace`. `'all'` removes the param.
 *
 * @returns The current value and a setter.
 */
function useLifecycleUrlFilter(): [LifecycleFilterValue, (next: LifecycleFilterValue) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const value = parseLifecycleParam(searchParams.get('lifecycle'));
  const setValue = (next: LifecycleFilterValue) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next === 'all') params.delete('lifecycle');
    else params.set('lifecycle', next);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  return [value, setValue];
}

/**
 * Filters table rows to the selected lifecycle.
 *
 * `'all'` returns every row. Rows without `lifecycle_status` count as `'live'`.
 */
function filterRowsByLifecycle<R extends { lifecycle_status?: LifecycleStatus }>(
  rows: R[],
  filter: LifecycleFilterValue,
): R[] {
  if (filter === 'all') return rows;
  // Rows without a lifecycle status count as `'live'`.
  return rows.filter((r) => (r.lifecycle_status ?? 'live') === filter);
}

/** Props for the participant-profile tab (any `profile_*` domain). */
interface DomainTabProps {
  /** The signed-in coordinator's own domain, from its `aggregator_type`. */
  domainId: string | undefined;
}

function SeekersTab({ domainId }: Readonly<DomainTabProps>) {
  const t = useTranslations('dashboard');
  const locale = useLocale();
  // `/aggregator/dashboard` scopes results to the caller's org and returns
  // each domain under `by_domain[<id>]`. An `undefined` domain id skips the
  // fetch.
  const seekerDomainId = domainId;
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [lifecycleFilter, setLifecycleFilter] = useLifecycleUrlFilter();
  const handleStatusFilterChange = (next: StatusFilter) => {
    setPage(1);
    setStatusFilter(next);
  };
  const handleLifecycleFilterChange = (next: LifecycleFilterValue) => {
    setPage(1);
    setLifecycleFilter(next);
  };
  const filterActive = statusFilter !== 'all';
  const {
    data: dashboard,
    isLoading,
    isError,
  } = useDashboard(
    seekerDomainId
      ? {
          domain: seekerDomainId,
          page,
          limit: PAGE_SIZE,
          ...(filterActive ? { status: statusFilter } : {}),
          ...(lifecycleFilter === 'draft' || lifecycleFilter === 'live'
            ? { lifecycle: lifecycleFilter }
            : {}),
        }
      : undefined,
  );
  const slice = seekerDomainId ? dashboard?.by_domain[seekerDomainId] : undefined;
  const rollup = slice?.rollup;
  const { data: cfg } = useAggregatorConfig();
  const seekerCfg = cfg?.domains?.find((d) => d.id === seekerDomainId);
  const seekerPlural = seekerCfg?.plural_label ?? t('tabs.seekers');
  const defaultTiles = useDefaultTiles(seekerPlural);
  // Bucket labels for the Initiated and Received columns.
  const initiatedLabels = cfg?.dashboardBuckets?.by_initiated_action_status ?? {};
  const receivedLabels = cfg?.dashboardBuckets?.by_received_action_status ?? {};
  const statusLabels = cfg?.dashboardBuckets?.by_status ?? {};
  const statusRules = indexStatusRules(seekerCfg?.status_rules);
  const total = rollup?.total_items;
  const byStatus = rollup?.by_status ?? {};
  // Keep the unfiltered status list so the dropdown stays full when a filter is set.
  const [cachedByStatus, setCachedByStatus] = useState<Record<string, number> | undefined>();
  useEffect(() => {
    if (!filterActive && rollup?.by_status) {
      setCachedByStatus(rollup.by_status);
    }
  }, [filterActive, rollup?.by_status]);
  const statusOptions = useMemo(
    () => buildStatusOptions(cachedByStatus ?? byStatus, t('filters.all_statuses')),
    [cachedByStatus, byStatus, t],
  );
  // Pick the status keys the UI shows; others still appear in the items list.
  const active = byStatus['active'] ?? byStatus['new'];
  const atRisk = byStatus['at_risk'];
  const inactive = byStatus['inactive'];
  const rows = useMemo(
    () => (slice?.items ?? []).map((p, i) => toSeekerRow(p, locale, i)),
    [slice?.items, locale],
  );
  const filteredRows = useMemo(
    () => filterRowsByLifecycle(rows, lifecycleFilter),
    [rows, lifecycleFilter],
  );

  // Fetch every matching seeker for "Select all N matching".
  const fetchAllSeekers = async () => {
    if (!seekerDomainId) return [];
    const res = await dashboardService.dashboard({
      domain: seekerDomainId,
      page: 1,
      limit: slice?.total_matching ?? total ?? PAGE_SIZE,
      ...(filterActive ? { status: statusFilter } : {}),
      // Apply the lifecycle filter too, since `total_matching` is the filtered count.
      ...(lifecycleFilter === 'draft' || lifecycleFilter === 'live'
        ? { lifecycle: lifecycleFilter }
        : {}),
    });
    const all = (res.by_domain[seekerDomainId]?.items ?? []).map((p, i) =>
      toSeekerRow(p, locale, i),
    );
    return filterRowsByLifecycle(all, lifecycleFilter);
  };

  // Refresh: asks signalstack to recompute the rollup, then invalidates the query cache.
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  async function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      if (!seekerDomainId) return;
      await dashboardService.dashboard({
        domain: seekerDomainId,
        page,
        limit: PAGE_SIZE,
        ...(filterActive ? { status: statusFilter } : {}),
        refresh: true,
      });
      await queryClient.invalidateQueries({
        queryKey: ['dashboard', 'dashboard', seekerDomainId],
      });
      setLastRefreshedAt(Date.now());
    } catch (err) {
      console.error('Dashboard refresh failed', err);
      setRefreshError(err instanceof Error ? err.message : 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <SummaryBar
        icon="users"
        label={seekerPlural}
        total={total}
        refreshing={refreshing}
        refreshError={refreshError}
        lastRefreshedAt={lastRefreshedAt}
        onRefresh={() => {
          void handleRefresh();
        }}
      />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          tone="new"
          icon="spark"
          count={fmtCount(byStatus['new'] ?? 0)}
          label={statusRules['new']?.label ?? statusLabels['new'] ?? t('statuses.new')}
          hint={statusRules['new']?.description ?? t('hints.new')}
        />
        <StatCard
          tone="active"
          icon="users"
          count={fmtCount(active)}
          label={
            statusRules['active']?.label ??
            statusLabels['active'] ??
            `${t('statuses.active')} ${seekerPlural}`
          }
          hint={statusRules['active']?.description ?? t('hints.active')}
        />
        <StatCard
          tone="risk"
          icon="alert"
          count={fmtCount(atRisk)}
          label={statusRules['at_risk']?.label ?? statusLabels['at_risk'] ?? t('statuses.at_risk')}
          hint={statusRules['at_risk']?.description ?? t('hints.at_risk')}
        />
        <StatCard
          tone="inactive"
          icon="pause"
          count={fmtCount(inactive)}
          label={
            statusRules['inactive']?.label ?? statusLabels['inactive'] ?? t('statuses.inactive')
          }
          hint={statusRules['inactive']?.description ?? t('hints.inactive')}
        />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Profile-level tiles */}
        <MetricGroup title={seekerCfg?.dashboardTiles?.profile_title ?? t('groups.profiles')}>
          {resolveTiles(seekerCfg?.dashboardTiles?.profile, defaultTiles.profile, rollup).map(
            (tile) => (
              <MiniStat
                key={`p-${tile.field}`}
                icon={TILE_ICONS[tile.field]}
                label={tile.label}
                value={fmtCount(tile.value)}
                sub={tileSub(tile.field, t, seekerPlural, rollup)}
              />
            ),
          )}
        </MetricGroup>

        {/* User-level tiles */}
        <MetricGroup title={seekerCfg?.dashboardTiles?.user_title ?? t('groups.users')}>
          {resolveTiles(seekerCfg?.dashboardTiles?.user, defaultTiles.user, rollup).map((tile) => (
            <MiniStat
              key={`u-${tile.field}`}
              icon={TILE_ICONS[tile.field]}
              label={tile.label}
              value={fmtCount(tile.value)}
              sub={tileSub(tile.field, t, seekerPlural, rollup)}
            />
          ))}
        </MetricGroup>
      </div>

      {isLoading ? (
        <LoadingCard />
      ) : isError ? (
        <ErrorCard />
      ) : (
        <ParticipantTable
          kind="seeker"
          rows={filteredRows}
          total={slice?.total_matching ?? total}
          page={page}
          pageSize={PAGE_SIZE}
          onPageChange={setPage}
          statusFilter={statusFilter}
          onStatusFilterChange={handleStatusFilterChange}
          statusOptions={statusOptions}
          initiatedLabels={initiatedLabels}
          receivedLabels={receivedLabels}
          lifecycleFilter={lifecycleFilter}
          onLifecycleFilterChange={handleLifecycleFilterChange}
          domain={seekerDomainId}
          onSelectAllMatching={fetchAllSeekers}
        />
      )}
    </div>
  );
}

/** Formats a numeric stat value, or an em dash when it is missing. */
function fmtCount(n: number | null | undefined): string {
  if (n === undefined || n === null) return '—';
  // At most 2 decimals (1.1666… → "1.17"), in the runtime locale.
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/**
 * Returns a row's lifecycle from signalstack's `lifecycle_status`.
 *
 * Falls back to the completion percentage when the field is missing; that
 * fallback can label an unconsented profile as `live`.
 */
function resolveLifecycleStatus(raw: unknown, completion: number): LifecycleStatus {
  if (raw === 'draft' || raw === 'live' || raw === 'paused') return raw;
  return completion >= 100 ? 'live' : 'draft';
}

/**
 * Maps a signalstack dashboard participant onto the `Seeker` row shape.
 *
 * The dashboard response has no `name`, `city`, or role fields, so those show
 * as em dashes.
 */
function toSeekerRow(participant: Record<string, unknown>, locale: string, index: number): Seeker {
  // Row key: profile_item_id, else the array index. user_id is not unique per row.
  const profileItemId =
    typeof participant.profile_item_id === 'string' ? participant.profile_item_id : '';
  const status = mapSeekerStatus(
    typeof participant.profile_status === 'string' ? participant.profile_status : null,
  );
  const completion =
    typeof participant.profile_completion_pct === 'number' ? participant.profile_completion_pct : 0;
  // See resolveLifecycleStatus.
  const lifecycle_status = resolveLifecycleStatus(participant.lifecycle_status, completion);
  const lifecycleFields: Pick<Seeker, 'lifecycle_status'> = { lifecycle_status };
  const created =
    typeof participant.profile_created_at === 'string' ? participant.profile_created_at : '';
  const updated =
    typeof participant.profile_last_updated_at === 'string'
      ? participant.profile_last_updated_at
      : '';
  const name =
    typeof participant.name === 'string' && participant.name.trim() ? participant.name : '—';
  const initiated = mapDirectional(participant.initiated);
  const received = mapDirectional(participant.received);
  return {
    // `row-` prefix avoids clashing with a numeric profile_item_id.
    id: profileItemId || `row-${index}`,
    name,
    city: '—',
    joined: created
      ? new Intl.DateTimeFormat(locale, {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
        }).format(new Date(created))
      : '—',
    avatar: avatarInitials(name),
    profile: { title: '—', exp: '—', verified: false, complete: completion },
    initiated,
    received,
    // Combined (initiated + received) view, kept for non-table consumers.
    applied: {
      total:
        initiated.create +
        initiated.accept +
        initiated.reject +
        initiated.cancel +
        received.create +
        received.accept +
        received.reject +
        received.cancel,
      accepted: initiated.accept + received.accept,
      rejected: initiated.reject + received.reject,
      pending: initiated.create + received.create,
      cancelled: initiated.cancel + received.cancel,
    },
    status,
    last: updated ? formatRelative(updated) : '—',
    actionableTags: Array.isArray(participant.actionable_tags)
      ? (participant.actionable_tags as unknown[]).filter((t): t is string => typeof t === 'string')
      : [],
    ...lifecycleFields,
  };
}

function mapSeekerStatus(raw: string | null): ParticipantStatus {
  if (raw === 'at_risk') return 'at-risk';
  if (raw === 'inactive') return 'inactive';
  return 'active';
}

function avatarInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed === '—') return '??';
  const parts = trimmed.split(/\s+/).filter(Boolean);
  const first = parts[0] ?? '';
  if (parts.length === 1) return first.slice(0, 2).toUpperCase() || '??';
  const last = parts[parts.length - 1] ?? '';
  const initials = (first.charAt(0) + last.charAt(0)).toUpperCase();
  return initials || '??';
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function ProvidersTab({ domainId }: Readonly<DomainTabProps>) {
  const t = useTranslations('dashboard');
  const locale = useLocale();
  // Same rollup shape and fetch as SeekersTab; only the labels differ.
  const providerDomainId = domainId;
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [lifecycleFilter, setLifecycleFilter] = useLifecycleUrlFilter();
  const handleStatusFilterChange = (next: StatusFilter) => {
    setPage(1);
    setStatusFilter(next);
  };
  const handleLifecycleFilterChange = (next: LifecycleFilterValue) => {
    setPage(1);
    setLifecycleFilter(next);
  };
  const filterActive = statusFilter !== 'all';
  const {
    data: dashboard,
    isLoading,
    isError,
  } = useDashboard(
    providerDomainId
      ? {
          domain: providerDomainId,
          page,
          limit: PAGE_SIZE,
          ...(filterActive ? { status: statusFilter } : {}),
          ...(lifecycleFilter === 'draft' || lifecycleFilter === 'live'
            ? { lifecycle: lifecycleFilter }
            : {}),
        }
      : undefined,
  );
  const { data: cfg } = useAggregatorConfig();
  const providerCfg = cfg?.domains?.find((d) => d.id === providerDomainId);
  const providerPlural = providerCfg?.plural_label ?? t('tabs.providers');
  const defaultTiles = useDefaultTiles(providerPlural);
  // Bucket labels for the Initiated and Received columns.
  const initiatedLabels = cfg?.dashboardBuckets?.by_initiated_action_status ?? {};
  const receivedLabels = cfg?.dashboardBuckets?.by_received_action_status ?? {};
  const statusLabels = cfg?.dashboardBuckets?.by_status ?? {};
  const statusRules = indexStatusRules(providerCfg?.status_rules);
  const slice = providerDomainId ? dashboard?.by_domain[providerDomainId] : undefined;
  const rollup = slice?.rollup;
  const total = rollup?.total_items;
  const byStatus = rollup?.by_status ?? {};
  const active = byStatus['active'] ?? byStatus['new'];
  const atRisk = byStatus['at_risk'];
  const inactive = byStatus['inactive'];
  const rows = useMemo(
    () => (slice?.items ?? []).map((p, i) => toProviderRow(p, locale, i)),
    [slice?.items, locale],
  );
  const filteredRows = useMemo(
    () => filterRowsByLifecycle(rows, lifecycleFilter),
    [rows, lifecycleFilter],
  );
  // Fetch every matching provider for "Select all N matching".
  const fetchAllProviders = async () => {
    if (!providerDomainId) return [];
    const res = await dashboardService.dashboard({
      domain: providerDomainId,
      page: 1,
      limit: slice?.total_matching ?? total ?? PAGE_SIZE,
      ...(filterActive ? { status: statusFilter } : {}),
      // Apply the lifecycle filter too, since `total_matching` is the filtered count.
      ...(lifecycleFilter === 'draft' || lifecycleFilter === 'live'
        ? { lifecycle: lifecycleFilter }
        : {}),
    });
    const all = (res.by_domain[providerDomainId]?.items ?? []).map((p, i) =>
      toProviderRow(p, locale, i),
    );
    return filterRowsByLifecycle(all, lifecycleFilter);
  };
  const [cachedByStatus, setCachedByStatus] = useState<Record<string, number> | undefined>();
  useEffect(() => {
    if (!filterActive && rollup?.by_status) {
      setCachedByStatus(rollup.by_status);
    }
  }, [filterActive, rollup?.by_status]);
  const statusOptions = useMemo(
    () => buildStatusOptions(cachedByStatus ?? byStatus, t('filters.all_statuses')),
    [cachedByStatus, byStatus, t],
  );

  // Refresh: asks signalstack to recompute the rollup, then invalidates the query cache.
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  async function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      if (!providerDomainId) return;
      await dashboardService.dashboard({
        domain: providerDomainId,
        page,
        limit: PAGE_SIZE,
        ...(filterActive ? { status: statusFilter } : {}),
        refresh: true,
      });
      await queryClient.invalidateQueries({
        queryKey: ['dashboard', 'dashboard', providerDomainId],
      });
      setLastRefreshedAt(Date.now());
    } catch (err) {
      console.error('Dashboard refresh failed', err);
      setRefreshError(err instanceof Error ? err.message : 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <SummaryBar
        icon="briefcase"
        label={providerPlural}
        total={total}
        refreshing={refreshing}
        refreshError={refreshError}
        lastRefreshedAt={lastRefreshedAt}
        onRefresh={() => {
          void handleRefresh();
        }}
      />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          tone="new"
          icon="spark"
          count={fmtCount(byStatus['new'] ?? 0)}
          label={statusRules['new']?.label ?? statusLabels['new'] ?? t('statuses.new')}
          hint={statusRules['new']?.description ?? t('hints.new')}
        />
        <StatCard
          tone="active"
          icon="briefcase"
          count={fmtCount(active)}
          label={statusRules['active']?.label ?? statusLabels['active'] ?? t('statuses.active')}
          hint={statusRules['active']?.description ?? t('hints.active')}
        />
        <StatCard
          tone="risk"
          icon="alert"
          count={fmtCount(atRisk)}
          label={statusRules['at_risk']?.label ?? statusLabels['at_risk'] ?? t('statuses.at_risk')}
          hint={statusRules['at_risk']?.description ?? t('hints.at_risk')}
        />
        <StatCard
          tone="inactive"
          icon="pause"
          count={fmtCount(inactive)}
          label={
            statusRules['inactive']?.label ?? statusLabels['inactive'] ?? t('statuses.inactive')
          }
          hint={statusRules['inactive']?.description ?? t('hints.inactive')}
        />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Profile-level tiles */}
        <MetricGroup title={providerCfg?.dashboardTiles?.profile_title ?? t('groups.profiles')}>
          {resolveTiles(providerCfg?.dashboardTiles?.profile, defaultTiles.profile, rollup).map(
            (tile) => (
              <MiniStat
                key={`p-${tile.field}`}
                icon={TILE_ICONS[tile.field]}
                label={tile.label}
                value={fmtCount(tile.value)}
                sub={tileSub(tile.field, t, providerPlural, rollup)}
              />
            ),
          )}
        </MetricGroup>

        {/* User-level tiles */}
        <MetricGroup title={providerCfg?.dashboardTiles?.user_title ?? t('groups.users')}>
          {resolveTiles(providerCfg?.dashboardTiles?.user, defaultTiles.user, rollup).map(
            (tile) => (
              <MiniStat
                key={`u-${tile.field}`}
                icon={TILE_ICONS[tile.field]}
                label={tile.label}
                value={fmtCount(tile.value)}
                sub={tileSub(tile.field, t, providerPlural, rollup)}
              />
            ),
          )}
        </MetricGroup>
      </div>

      {isLoading ? (
        <LoadingCard />
      ) : isError ? (
        <ErrorCard />
      ) : (
        <ParticipantTable<Provider>
          kind="provider"
          rows={filteredRows}
          total={slice?.total_matching ?? total}
          page={page}
          pageSize={PAGE_SIZE}
          onPageChange={setPage}
          statusFilter={statusFilter}
          onStatusFilterChange={handleStatusFilterChange}
          statusOptions={statusOptions}
          initiatedLabels={initiatedLabels}
          receivedLabels={receivedLabels}
          lifecycleFilter={lifecycleFilter}
          onLifecycleFilterChange={handleLifecycleFilterChange}
          domain={providerDomainId}
          onSelectAllMatching={fetchAllProviders}
        />
      )}
    </div>
  );
}

function toProviderRow(
  participant: Record<string, unknown>,
  locale: string,
  index: number,
): Provider {
  const seeker = toSeekerRow(participant, locale, index);
  return { ...seeker, role: '—' };
}

export default function DashboardPageRoot() {
  const rawProfile = useProfileRaw();
  // Wait for the profile before mounting a tab, so no tab fetches the wrong domain.
  const profileType = rawProfile.data?.type;
  if (!profileType) {
    return <DashboardLoadingFrame />;
  }
  return <DashboardContent aggregatorType={profileType} />;
}

function DashboardLoadingFrame() {
  const t = useTranslations('dashboard');
  const { data: cfg = DEFAULT_AGGREGATOR_CONFIG } = useAggregatorConfig();
  return (
    <div className="fade-up">
      <Topbar
        title={`My ${cfg.brand.short_name}`}
        subtitle={cfg.brand.tagline ?? 'Track every participant in your network — at a glance.'}
      />
      <div className="text-center text-[13px] text-ink-400 py-12">{t('state.loading')}</div>
    </div>
  );
}

function DashboardContent({ aggregatorType }: { aggregatorType: string }) {
  const router = useRouter();
  const t = useTranslations('dashboard');
  const { data: cfg = DEFAULT_AGGREGATOR_CONFIG } = useAggregatorConfig();
  // Domain id from the config entry matching `aggregatorType`. Undefined when
  // no entry matches, which skips the dashboard fetch.
  const primaryDomainCfg = cfg.domains?.find((d) => d.id === aggregatorType);
  const primaryDomain = primaryDomainCfg?.id;
  // Provider-like when the domain's `item_type` is job postings, not profiles.
  const isProviderLike = (primaryDomainCfg?.item_type ?? '').startsWith('job_posting');
  const canOnboard = useCan()('profiles.onboard');

  return (
    <div className="fade-up">
      <Topbar
        title={`My ${cfg.brand.short_name}`}
        subtitle={cfg.brand.tagline ?? 'Track every participant in your network — at a glance.'}
        right={
          <div className="flex items-center gap-2">
            {canOnboard && (
              <Button icon={<I.plus size={14} />} onClick={() => router.push('/onboarding')}>
                {t('buttons.addParticipants')}
              </Button>
            )}
          </div>
        }
      />

      {/* No tab strip: the tab is fixed by the aggregator's type. */}
      {isProviderLike ? (
        <ProvidersTab domainId={primaryDomain} />
      ) : (
        <SeekersTab domainId={primaryDomain} />
      )}
    </div>
  );
}
