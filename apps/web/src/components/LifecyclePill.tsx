'use client';

import { useTranslations } from 'next-intl';

import type { LifecycleStatus } from '../types';

/**
 * Pill states: the server's {@link LifecycleStatus} plus the UI-only
 * `account_only` state (a user with no item yet, sent as a `null` lifecycle).
 */
export type PillStatus = LifecycleStatus | 'account_only';

const TONE: Record<PillStatus, string> = {
  draft: 'bg-amber-100 text-amber-800 border border-amber-200',
  live: 'bg-emerald-100 text-emerald-800 border border-emerald-200',
  paused: 'bg-slate-200 text-slate-700 border border-slate-300',
  account_only: 'bg-slate-100 text-slate-600 border border-slate-200',
};

/**
 * Coloured pill that shows a signals item's lifecycle status.
 *
 * `undefined` renders as `'live'`; `null` renders as `'account_only'`.
 *
 * @param status - The lifecycle from the API, or undefined/null when absent.
 */
export function LifecyclePill({ status }: { status?: PillStatus | null }) {
  const t = useTranslations('Lifecycle');
  const resolved: PillStatus = status === null ? 'account_only' : (status ?? 'live');
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${TONE[resolved]}`}
    >
      {t(resolved)}
    </span>
  );
}
