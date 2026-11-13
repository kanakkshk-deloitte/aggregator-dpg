'use client';

/**
 * A user's roles in one organisation: the base role from membership, and the
 * additional roles the caller may assign or revoke (PII Access and Data
 * Export for a coordinator, Org Onboarder for an owner, custom roles). The
 * API applies every rule and audits every change.
 *
 * A role with a day limit is assigned for a chosen number of days. A role that
 * reveals personal data, and every removal, asks for confirmation first.
 */

import { useState, type ReactNode } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Clock, Download, Lock, Shield, type LucideIcon } from 'lucide-react';
import type {
  Role,
  RoleAssignment,
  RevokeRoleResponse,
  UserRolesResponse,
} from '@aggregator-dpg/shared-primitives/user-org';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { cn } from '../../lib/cn';
import { errorKey, sendConsole } from '../../lib/console-client';

/** Durations offered for a time-limited role, in days, up to the role's limit. */
const DURATIONS = [30, 60, 90];

/** Code-unit order, as `sort()` without a compare function; locale-independent. */
function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** Whether a role reveals personal data. */
function isPersonalData(role: Role | undefined): boolean {
  return role?.permissions.some((p) => p.includes('pii')) ?? false;
}

/** The icon for a role, from what it allows. */
function roleIcon(role: Role | undefined): LucideIcon {
  if (isPersonalData(role)) return Lock;
  if (role?.permissions.some((p) => p.endsWith('.export'))) return Download;
  return Shield;
}

/** The day choices for a role limited to `max` days. */
function durationsFor(max: number): number[] {
  const within = DURATIONS.filter((d) => d < max);
  return [...within, max];
}

/** A pending confirmation. */
type Pending =
  { kind: 'assign'; key: string; days: number | null } | { kind: 'revoke'; key: string };

export function RolesPanel({
  userId,
  orgId,
  initial,
  roles,
  title,
  personName,
}: Readonly<{
  userId: string;
  orgId: string;
  initial: UserRolesResponse;
  roles: Role[];
  title?: string;
  /** Named in the confirmation for a personal-data role. */
  personName?: string;
}>) {
  const t = useTranslations('console');
  const format = useFormatter();
  const [additional, setAdditional] = useState<RoleAssignment[]>(initial.additional);
  const [days, setDays] = useState<Record<string, number>>({});
  const [pending, setPending] = useState<Pending | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const roleOf = (key: string) => roles.find((r) => r.key === key);
  const nameOf = (key: string) => roleOf(key)?.name ?? key;
  const base = initial.base.filter((b) => b.org_id === orgId);
  const assignable = new Set(
    initial.assignable.filter((a) => a.org_id === orgId).map((a) => a.role_key),
  );
  const liveOf = (key: string) =>
    additional.find((a) => a.role_key === key && a.org_id === orgId && a.live);
  const shown = [
    ...new Set([
      ...assignable,
      ...additional.filter((a) => a.org_id === orgId && a.live).map((a) => a.role_key),
    ]),
  ].sort(compareCodeUnits);

  if (base.length === 0 && shown.length === 0) return null;

  const daysFor = (key: string): number | null => {
    const max = roleOf(key)?.max_days ?? null;
    return max ? (days[key] ?? max) : null;
  };
  const dateOf = (iso: string) =>
    format.dateTime(new Date(iso), { day: 'numeric', month: 'short', year: 'numeric' });

  async function assign(key: string, forDays: number | null) {
    setBusy(true);
    const r = await sendConsole<RoleAssignment>(`/api/console/user/role/assign/${userId}`, 'POST', {
      role_key: key,
      org_id: orgId,
      ...(forDays ? { days: forDays } : {}),
    });
    setBusy(false);
    setPending(null);
    if (r.ok) {
      setAdditional((as) => [
        r.data,
        ...as.map((a) => (a.role_key === key && a.org_id === orgId ? { ...a, live: false } : a)),
      ]);
      setNote(t('roles.assigned_note', { role: nameOf(key) }));
    } else {
      setNote(t(errorKey(r)));
    }
  }

  async function revoke(key: string) {
    setBusy(true);
    const r = await sendConsole<RevokeRoleResponse>(
      `/api/console/user/role/revoke/${userId}`,
      'POST',
      { role_key: key, org_id: orgId },
    );
    setBusy(false);
    setPending(null);
    if (r.ok) {
      setAdditional((as) =>
        as.map((a) => (a.role_key === key && a.org_id === orgId ? { ...a, live: false } : a)),
      );
      setNote(t('roles.removed_note', { role: nameOf(key) }));
    } else {
      setNote(t(errorKey(r)));
    }
  }

  function startAssign(key: string) {
    const forDays = daysFor(key);
    if (isPersonalData(roleOf(key))) setPending({ kind: 'assign', key, days: forDays });
    else void assign(key, forDays);
  }

  function confirm() {
    if (!pending) return;
    if (pending.kind === 'assign') void assign(pending.key, pending.days);
    else void revoke(pending.key);
  }

  let dialog: { title: string; body: string; yes: string; danger: boolean } | null = null;
  if (pending?.kind === 'assign') {
    dialog = {
      title: t('roles.confirm_pii_title', { role: nameOf(pending.key) }),
      body: pending.days
        ? t('roles.confirm_pii_body', {
            name: personName ?? t('roles.this_person'),
            days: pending.days,
          })
        : t('roles.confirm_pii_body_no_expiry', { name: personName ?? t('roles.this_person') }),
      yes: t('roles.confirm_pii_yes'),
      danger: false,
    };
  } else if (pending?.kind === 'revoke') {
    dialog = {
      title: t('roles.confirm_remove_title', { role: nameOf(pending.key) }),
      body: t('roles.confirm_remove_body'),
      yes: t('roles.revoke'),
      danger: true,
    };
  }

  return (
    <section className="bd-card bd-shadow">
      <header className="px-[22px] pt-[18px]">
        <h2 className="font-display text-[16px] font-bold text-ink-900">
          {title ?? t('roles.title')}
        </h2>
        <p className="mt-0.5 text-[13px] text-ink-500">{t('roles.subtitle')}</p>
      </header>
      <ul className="flex flex-col px-[22px] pt-4 text-[13.5px]">
        {base.map((b) => (
          <li
            key={b.role_key}
            data-testid={`role-base-${b.role_key}`}
            className="grid grid-cols-[40px_minmax(0,1fr)] items-center gap-3.5 border-t border-(--bd-border-soft) py-3.5 first:border-t-0 first:pt-0 sm:grid-cols-[40px_minmax(0,1fr)_auto]"
          >
            <RoleIcon icon={Shield} tone="primary" />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 font-bold text-ink-900">
                {nameOf(b.role_key)}
                <Tag tone="green">{t('roles.base_tag')}</Tag>
              </div>
              <div className="text-[12.5px] text-ink-500">{t('roles.base_desc')}</div>
            </div>
            <span className="col-span-2 inline-flex items-center gap-1.5 text-[12.5px] text-ink-500 sm:col-span-1">
              <Lock size={13} aria-hidden="true" />
              {t('roles.locked')}
            </span>
          </li>
        ))}
        {shown.map((key) => {
          const role = roleOf(key);
          const live = liveOf(key);
          const pii = isPersonalData(role);
          const max = role?.max_days ?? null;
          let tone: 'primary' | 'rose' | 'muted' = 'muted';
          if (live) tone = pii ? 'rose' : 'primary';
          let status = t('roles.none');
          if (live) {
            status = live.expires_at
              ? t('roles.until', { date: dateOf(live.expires_at) })
              : t('roles.no_expiry');
          }
          return (
            <li
              key={key}
              className="grid grid-cols-[40px_minmax(0,1fr)] items-center gap-3.5 border-t border-(--bd-border-soft) py-3.5 first:border-t-0 first:pt-0 sm:grid-cols-[40px_minmax(0,1fr)_auto]"
            >
              <RoleIcon icon={roleIcon(role)} tone={tone} />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 font-bold text-ink-900">
                  {nameOf(key)}
                  {live ? <Tag tone="green">{t('roles.assigned')}</Tag> : null}
                  {pii ? <Tag tone="rose">{t('roles.personal_data')}</Tag> : null}
                </div>
                <div data-testid={`role-${key}`} className="text-[12.5px] text-ink-500">
                  {status}
                  {role?.description ? ` · ${role.description}` : ''}
                </div>
              </div>
              <div className="col-span-2 flex flex-wrap items-center gap-2 sm:col-span-1 sm:justify-end">
                {live && assignable.has(key) ? (
                  <Button
                    kind="danger"
                    disabled={busy}
                    onClick={() => setPending({ kind: 'revoke', key })}
                  >
                    {t('roles.revoke')}
                  </Button>
                ) : null}
                {live ? null : (
                  <>
                    {max ? (
                      <select
                        aria-label={t('roles.duration', { role: nameOf(key) })}
                        value={daysFor(key) ?? max}
                        onChange={(e) => setDays((d) => ({ ...d, [key]: Number(e.target.value) }))}
                        className="h-9 rounded-[10px] border border-(--bd-border) bg-(--bd-card) px-2 text-[13px] text-ink-900"
                      >
                        {durationsFor(max).map((n) => (
                          <option key={n} value={n}>
                            {t('roles.days', { days: n })}
                          </option>
                        ))}
                      </select>
                    ) : null}
                    <Button disabled={busy} onClick={() => startAssign(key)}>
                      {t('roles.assign')}
                    </Button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="mx-[22px] mt-1 mb-[18px] flex flex-col gap-2 border-t border-(--bd-border-soft) pt-3 text-[12.5px] text-ink-500">
        <span className="inline-flex items-center gap-2">
          <Clock size={14} aria-hidden="true" />
          {t('roles.recorded')}
        </span>
        {note ? <output className="text-[13px] text-ink-700">{note}</output> : null}
      </div>
      <ConfirmDialog
        open={dialog !== null}
        title={dialog?.title ?? ''}
        body={dialog?.body ?? ''}
        confirmLabel={dialog?.yes ?? ''}
        cancelLabel={t('roles.cancel')}
        danger={dialog?.danger ?? false}
        busy={busy}
        onConfirm={confirm}
        onCancel={() => setPending(null)}
      />
    </section>
  );
}

/** A role's icon tile. */
function RoleIcon({
  icon: Icon,
  tone,
}: Readonly<{ icon: LucideIcon; tone: 'primary' | 'rose' | 'muted' }>) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid h-10 w-10 place-items-center rounded-[11px]',
        tone === 'primary' && 'bg-(--bd-primary-50) text-(--bd-primary-600)',
        tone === 'rose' && 'bg-rose-50 text-rose-600',
        tone === 'muted' && 'bg-(--bd-border-soft) text-ink-500',
      )}
    >
      <Icon size={17} />
    </span>
  );
}

/** A small coloured label beside a role name. */
function Tag({ tone, children }: Readonly<{ tone: 'green' | 'rose'; children: ReactNode }>) {
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-[11px] font-bold',
        tone === 'green' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700',
      )}
    >
      {children}
    </span>
  );
}
