'use client';

/**
 * Coordinator actions: approve or reject a pending coordinator (optional
 * reason, emailed to the applicant) and change the domains served. A 409
 * ALREADY_DECIDED response updates the status in place. The decision card
 * shows only while pending or just decided. A viewer who cannot manage the
 * coordinator's organisation sees the domains read-only and no actions.
 *
 * Domains can be changed only while the coordinator is pending; after a
 * decision they are shown read-only.
 *
 * Domains are the network's configured domains. A coordinator saved with none
 * serves every domain, so all are shown ticked. A save bar appears once the
 * choice differs from what is saved, and at least one domain must stay ticked.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { Check, CircleCheck, CircleX, Clock, Tag } from 'lucide-react';
import type { DecisionResponse, User } from '@aggregator-dpg/shared-primitives/user-org';
import { Button } from '../ui/Button';
import { I } from '../../icons';
import { cn } from '../../lib/cn';
import { ConsoleStatusPill } from './ConsoleUi';
import { DomainChips } from './DomainChips';
import { sendConsole, type ConsoleError, type ConsoleSendResult } from '../../lib/console-client';
import { plainErrorKey } from '../../lib/console-errors';

/** API error codes with their own message on this page. */
const ACTION_ERROR_CODES = { TARGET_ORG_INACTIVE: 'org_inactive' } as const;

/** The message key for a failed decision or domains save. */
function actionErrorKey(r: { status: number; error: ConsoleError }): string {
  return plainErrorKey(r, 'coordinator', ACTION_ERROR_CODES);
}

/** Whether two id lists hold the same ids, in any order. */
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/** What a decision call means for the page. */
interface DecisionView {
  /** The coordinator's status now; null when unchanged. */
  status: User['status'] | null;
  /** The message to show. */
  note: string;
  /** The decision is settled: close the reject step and refresh the page. */
  settled: boolean;
}

/**
 * Turns a decision response into the status and message to show. A 409
 * ALREADY_DECIDED carries the current status, so the page updates in place.
 *
 * @param r - The decision response.
 * @param t - The console translator.
 * @returns The view of the outcome.
 */
function decisionView(
  r: ConsoleSendResult<DecisionResponse>,
  t: ReturnType<typeof useTranslations<'console'>>,
): DecisionView {
  if (r.ok) {
    const approved = r.data.status === 'active';
    return {
      status: r.data.status,
      note: approved ? t('coordinator.approved_note') : t('coordinator.rejected_note'),
      settled: true,
    };
  }
  if (r.error.code === 'ALREADY_DECIDED') {
    const now = (r.error.fields?.['status'] as User['status'] | undefined) ?? null;
    const label = now ? t(`status.${now}`) : '';
    return { status: now, note: t('coordinator.already', { status: label }), settled: true };
  }
  return { status: null, note: t(actionErrorKey(r)), settled: false };
}

export function CoordinatorActions({
  user,
  domains,
  readOnly = false,
}: Readonly<{
  user: User;
  domains: Array<{ id: string; label: string }>;
  /** Show status and domains only, with no decision or domain editing. */
  readOnly?: boolean;
}>) {
  const t = useTranslations('console');
  const router = useRouter();
  const [status, setStatus] = useState(user.status);
  const [reason, setReason] = useState('');
  // An empty `serves` means every domain, shown as all of them ticked.
  const ticked = (serves: readonly string[]) =>
    serves.length ? [...serves] : domains.map((d) => d.id);
  const [saved, setSaved] = useState<string[]>(() => ticked(user.serves));
  const [chosen, setChosen] = useState<string[]>(() => ticked(user.serves));
  const [decisionNote, setDecisionNote] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [servesNote, setServesNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function decide(decision: 'approve' | 'reject') {
    setBusy(true);
    const body =
      decision === 'reject' && reason.trim() ? { decision, reason: reason.trim() } : { decision };
    const r = await sendConsole<DecisionResponse>(
      `/api/console/user/decision/${user.id}`,
      'POST',
      body,
    );
    setBusy(false);
    const view = decisionView(r, t);
    if (view.status) setStatus(view.status);
    setDecisionNote(view.note);
    if (view.settled) {
      setRejecting(false);
      router.refresh();
    }
  }

  const dirty = !sameIds(chosen, saved);
  const empty = chosen.length === 0;

  function toggle(id: string) {
    setServesNote(null);
    setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  }

  function discard() {
    setChosen(saved);
    setServesNote(null);
  }

  async function saveServes() {
    setBusy(true);
    const r = await sendConsole<User>(`/api/console/user/metadata/${user.id}`, 'PATCH', {
      serves: chosen,
    });
    setBusy(false);
    if (!r.ok) {
      setServesNote(t(actionErrorKey(r)));
      return;
    }
    setSaved(ticked(r.data.serves));
    setChosen(ticked(r.data.serves));
    setServesNote(t('coordinator.domains_saved'));
  }

  return (
    <div className="flex flex-col gap-6">
      {!readOnly && (status === 'pending' || decisionNote) ? (
        <DecisionCard
          name={user.contact.name ?? user.contact.email}
          registeredAt={user.created_at}
          status={status}
          note={decisionNote}
          rejecting={rejecting}
          reason={reason}
          busy={busy}
          blocked={dirty}
          onReason={setReason}
          onApprove={() => void decide('approve')}
          onStartReject={() => setRejecting(true)}
          onCancelReject={() => {
            setRejecting(false);
            setReason('');
          }}
          onReject={() => void decide('reject')}
        />
      ) : null}

      {domains.length > 0 ? (
        <section className="bd-card bd-shadow">
          <header className="px-[22px] pt-[18px]">
            <h2 className="font-display text-[16px] font-bold text-ink-900">
              {t('coordinator.domains')}
            </h2>
            <p className="mt-0.5 text-[13px] text-ink-500">{t('coordinator.domains_sub')}</p>
          </header>
          <div className="flex flex-col gap-3.5 px-[22px] pt-4 pb-[22px] text-[13.5px]">
            {readOnly || status !== 'pending' ? (
              <DomainChips domains={domains.filter((d) => saved.includes(d.id))} />
            ) : (
              <>
                <fieldset
                  aria-label={t('coordinator.domains')}
                  className="m-0 min-w-0 border-0 p-0 grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2.5"
                >
                  {domains.map((d) => {
                    const on = chosen.includes(d.id);
                    return (
                      <label
                        key={d.id}
                        className={cn(
                          'flex cursor-pointer items-center gap-3 rounded-[12px] border-[1.5px] border-(--bd-border) bg-(--bd-card) p-3.5 transition-colors hover:border-ink-400 focus-within:shadow-[0_0_0_3px_var(--bd-primary-50)]',
                          on &&
                            'border-(--bd-primary) bg-(--bd-primary-50) hover:border-(--bd-primary)',
                        )}
                      >
                        <input
                          type="checkbox"
                          className="sr-only"
                          checked={on}
                          onChange={() => toggle(d.id)}
                        />
                        <span
                          aria-hidden="true"
                          className={cn(
                            'grid h-5 w-5 flex-none place-items-center rounded-md border-[1.5px] border-(--bd-border) bg-(--bd-card) text-white',
                            on && 'border-(--bd-primary) bg-(--bd-primary)',
                          )}
                        >
                          {on ? <Check size={12} strokeWidth={3.2} /> : null}
                        </span>
                        <Tag
                          size={17}
                          aria-hidden="true"
                          className="flex-none text-(--bd-primary-600)"
                        />
                        <span className="font-bold text-ink-900">{d.label}</span>
                      </label>
                    );
                  })}
                </fieldset>

                {dirty ? (
                  <div className="flex flex-wrap items-center gap-2.5 rounded-[12px] border border-(--bd-border-soft) bg-(--bd-bg) px-3 py-2.5">
                    <span
                      className={cn(
                        'mr-auto text-[13px]',
                        empty ? 'text-rose-700' : 'text-ink-500',
                      )}
                    >
                      {empty ? t('coordinator.domains_empty') : t('coordinator.unsaved')}
                    </span>
                    <Button kind="ghost" disabled={busy} onClick={discard}>
                      {t('coordinator.discard')}
                    </Button>
                    <Button disabled={busy || empty} onClick={() => void saveServes()}>
                      {t('coordinator.save_domains')}
                    </Button>
                  </div>
                ) : null}
                {servesNote ? (
                  <output className="text-[13px] text-ink-600">{servesNote}</output>
                ) : null}
              </>
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}

/** The registration decision: a pending review with Approve and Reject, or its outcome. */
function DecisionCard({
  name,
  registeredAt,
  status,
  note,
  rejecting,
  reason,
  busy,
  onReason,
  blocked,
  onApprove,
  onStartReject,
  onCancelReject,
  onReject,
}: Readonly<{
  name: string;
  registeredAt: string;
  status: User['status'];
  note: string | null;
  rejecting: boolean;
  reason: string;
  busy: boolean;
  onReason: (v: string) => void;
  /** Unsaved domain changes; Approve and Reject wait until they are saved or discarded. */
  blocked: boolean;
  onApprove: () => void;
  onStartReject: () => void;
  onCancelReject: () => void;
  onReject: () => void;
}>) {
  const t = useTranslations('console');
  const format = useFormatter();

  if (status !== 'pending') {
    const approved = status === 'active';
    const Icon = approved ? CircleCheck : CircleX;
    return (
      <section
        className={cn(
          'bd-card flex items-start gap-3 px-[22px] py-4',
          approved
            ? 'border-emerald-200 bg-emerald-500/8 text-emerald-800'
            : 'border-rose-200 bg-rose-500/8 text-rose-800',
        )}
      >
        <Icon size={20} aria-hidden="true" className="mt-0.5 flex-none" />
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2.5">
          {note ? <output className="font-semibold">{note}</output> : null}
          <span data-testid="coordinator-status">
            <ConsoleStatusPill status={status} />
          </span>
        </div>
      </section>
    );
  }

  return (
    <section className="bd-card bd-shadow overflow-hidden border-amber-200">
      <div className="flex flex-wrap items-start gap-3.5 bg-amber-500/8 px-[22px] py-[18px]">
        <span
          aria-hidden="true"
          className="grid h-10 w-10 flex-none place-items-center rounded-[11px] bg-amber-100 text-amber-700"
        >
          <Clock size={19} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-[16px] font-bold text-ink-900">
            {t('coordinator.decision_title')}
          </h2>
          <p className="mt-0.5 text-[13.5px] text-ink-600">
            {t('coordinator.decision_body', {
              name,
              date: format.dateTime(new Date(registeredAt), {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              }),
            })}
          </p>
        </div>
        {blocked && !rejecting ? (
          <p className="w-full text-[13px] text-amber-800">{t('coordinator.save_domains_first')}</p>
        ) : null}
        {rejecting ? null : (
          <div className="flex w-full gap-2 sm:w-auto">
            <Button
              disabled={busy || blocked}
              icon={<I.check size={15} />}
              onClick={onApprove}
              className="flex-1 justify-center sm:flex-none"
            >
              {t('coordinator.approve')}
            </Button>
            <Button
              kind="danger"
              disabled={busy || blocked}
              icon={<I.x size={15} />}
              onClick={onStartReject}
              className="flex-1 justify-center sm:flex-none"
            >
              {t('coordinator.reject')}
            </Button>
          </div>
        )}
      </div>
      {rejecting ? (
        <div className="flex flex-col gap-3 border-t border-amber-200 px-[22px] py-4 text-[13.5px]">
          <label className="flex max-w-2xl flex-col gap-1.5">
            <span className="bd-label">{t('coordinator.reason')}</span>
            <textarea
              className="bd-input min-h-[80px]"
              maxLength={500}
              value={reason}
              onChange={(e) => onReason(e.target.value)}
            />
          </label>
          <div className="flex gap-2">
            <Button kind="danger" disabled={busy} icon={<I.x size={15} />} onClick={onReject}>
              {t('coordinator.reject_confirm')}
            </Button>
            <Button kind="ghost" disabled={busy} onClick={onCancelReject}>
              {t('coordinator.cancel')}
            </Button>
          </div>
        </div>
      ) : null}
      {note ? (
        <output className="block border-t border-amber-200 px-[22px] py-3 text-[13px] text-rose-700">
          {note}
        </output>
      ) : null}
    </section>
  );
}
