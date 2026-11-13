'use client';

/**
 * Invites coordinators to an organisation. Addresses are typed or pasted into
 * a chip box, up to the per-send cap; each valid address can carry an optional
 * name for the email greeting. Invalid addresses block sending until they are
 * fixed or removed; reloading or closing the page with unsent emails asks
 * first. After sending, one line says how many invites went out and
 * why the rest did not. A side card explains the steps and the per-send limit.
 */

import {
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
  type SubmitEvent,
} from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Check, FileText, Info, Mail, X } from 'lucide-react';
import type { UserInviteResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { isEmailAddress, normaliseEmail } from '@aggregator-dpg/shared-primitives/phone';
import { Button } from '../ui/Button';
import { I } from '../../icons';
import { cn } from '../../lib/cn';
import { ConsoleSection } from './ConsoleUi';
import { sendConsole, type ConsoleError } from '../../lib/console-client';
import { DEFAULT_MAX_INVITES } from '../../lib/invite-limit';
import { useLeaveWarning } from '../../hooks/useLeaveWarning';

interface Recipient {
  email: string;
  name: string;
  valid: boolean;
}

interface NotSent {
  email: string;
  reason: string;
}

/** The steps in the help card, in order. The first is the sender's own step. */
const HELP_STEPS = [
  { key: 'send', Icon: Mail },
  { key: 'register', Icon: FileText },
  { key: 'approve', Icon: Check },
] as const;

/** Keys that turn the typed text into a chip. */
const COMMIT_KEYS = new Set(['Enter', ',', ';', ' ', 'Tab']);

/** `existing[].status` and `invalid[].reason` values with their own wording. */
const KNOWN_REASONS = new Set([
  'active',
  'pending',
  'inactive',
  'retired',
  'invalid_email',
  'duplicate_in_batch',
  'store_error',
]);

/**
 * Splits pasted or typed text into new recipients, skipping blanks and
 * addresses already in the list.
 *
 * @param text - Raw text; commas, semicolons, spaces and new lines separate.
 * @param current - The recipients already added.
 * @returns The recipients to append, in order.
 */
export function parseRecipients(text: string, current: readonly Recipient[]): Recipient[] {
  const seen = new Set(current.map((r) => r.email));
  const added: Recipient[] = [];
  for (const part of text.split(/[\s,;]+/)) {
    const email = normaliseEmail(part);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    added.push({ email, name: '', valid: isEmailAddress(email) });
  }
  return added;
}

/**
 * Appends the addresses in `text` to `current`, up to `max` in total.
 *
 * @returns The new list and how many addresses did not fit.
 */
function appendCapped(
  text: string,
  current: readonly Recipient[],
  max: number,
): { list: Recipient[]; skipped: number } {
  const added = parseRecipients(text, current);
  const room = Math.max(max - current.length, 0);
  return { list: [...current, ...added.slice(0, room)], skipped: Math.max(added.length - room, 0) };
}

/** The addresses the API did not email, with the reason key for each. */
function notSentOf(res: UserInviteResponse): NotSent[] {
  return [
    ...res.existing.map((e) => ({ email: e.email, reason: e.status })),
    ...res.invalid.map((i) => ({ email: i.email, reason: i.reason })),
  ];
}

/**
 * The message key for a failed send, worded for the person sending the invites.
 * The per-send cap is an API setting, so a cap lower than the form knew has its
 * own message.
 */
function failureKey(r: { status: number; error: ConsoleError }): string {
  if (r.status === 400 && r.error.fields?.field === 'recipients') return 'invite.too_many';
  if (r.status === 0) return 'invite.error.network';
  if (r.status === 400) return 'invite.error.invalid';
  if (r.status === 401) return 'invite.error.signed_out';
  if (r.status === 403) return 'invite.error.forbidden';
  if (r.status === 404 || r.status === 409) return 'invite.error.org_unavailable';
  if (r.status === 429) return 'invite.error.rate_limited';
  if (r.status >= 500) return 'invite.error.server';
  return 'invite.error.generic';
}

/** Renders a `<kbd>` chunk in rich message text. */
function renderKbd(chunks: ReactNode) {
  return (
    <kbd className="whitespace-nowrap rounded-[5px] border border-b-2 border-(--bd-border) bg-(--bd-card) px-1.5 font-mono text-[11px] text-ink-700">
      {chunks}
    </kbd>
  );
}

/** Renders a `<link>` chunk as a link to `href`, or as plain text without one. */
function linkTo(href: string | null) {
  return function renderLink(chunks: ReactNode) {
    if (!href) return chunks;
    return (
      <Link href={href} className="font-semibold text-(--bd-primary-600) hover:underline">
        {chunks}
      </Link>
    );
  };
}

export function InviteForm({
  orgs,
  maxRecipients = DEFAULT_MAX_INVITES,
  coordinatorsHref = null,
}: Readonly<{
  orgs: Array<{ id: string; name: string }>;
  /** Per-send cap (`INVITE_MAX_RECIPIENTS`), read by the page on the server. */
  maxRecipients?: number;
  /** Link to the coordinators list, or `null` when the actor cannot open it. */
  coordinatorsHref?: string | null;
}>) {
  const t = useTranslations('console');
  const [orgId, setOrgId] = useState(orgs[0]?.id ?? '');
  const [draft, setDraft] = useState('');
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [skipped, setSkipped] = useState(0);
  // The name of a chip moved back into the box, given back when it is added again.
  const [heldName, setHeldName] = useState('');
  const [result, setResult] = useState<{ sent: number; notSent: NotSent[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const valid = recipients.filter((r) => r.valid);
  const invalidCount = recipients.length - valid.length;
  const full = recipients.length >= maxRecipients;

  useLeaveWarning(recipients.length > 0 || draft.trim() !== '');

  function update(list: Recipient[], skippedNow = 0) {
    setRecipients(list);
    setSkipped(skippedNow);
  }

  /** Gives the held name to the first address added from the box, then drops it. */
  function withHeldName(list: Recipient[]): Recipient[] {
    if (!heldName || list.length <= recipients.length) return list;
    setHeldName('');
    const i = recipients.length;
    return list.map((r, j) => (j === i ? { ...r, name: heldName } : r));
  }

  function add(text: string) {
    const next = appendCapped(text, recipients, maxRecipients);
    update(withHeldName(next.list), next.skipped);
    setDraft('');
    setResult(null);
  }

  function remove(email: string) {
    update(recipients.filter((r) => r.email !== email));
    setResult(null);
  }

  /** Moves a chip back into the text box so it can be corrected; its name is kept. */
  function edit(email: string) {
    setHeldName(recipients.find((r) => r.email === email)?.name ?? '');
    remove(email);
    setDraft(email);
  }

  function setName(email: string, name: string) {
    setRecipients(recipients.map((r) => (r.email === email ? { ...r, name } : r)));
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (COMMIT_KEYS.has(e.key) && draft.trim()) {
      e.preventDefault();
      add(draft);
    } else if (e.key === 'Backspace' && !draft && recipients.length) {
      e.preventDefault();
      edit(recipients.at(-1)!.email);
    }
  }

  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    e.preventDefault();
    add(draft + ' ' + e.clipboardData.getData('text'));
  }

  async function onSubmit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    // Text still in the box counts, as if the user had pressed Enter.
    const next = draft.trim()
      ? appendCapped(draft, recipients, maxRecipients)
      : { list: recipients, skipped: 0 };
    const all = withHeldName(next.list);
    setDraft('');
    // Nothing valid, or an invalid address still in the list: show the list and its message.
    if (!all.some((r) => r.valid) || all.some((r) => !r.valid)) {
      update(all, next.skipped);
      return;
    }
    setBusy(true);
    setError(null);
    const r = await sendConsole<UserInviteResponse>('/api/console/user/invite', 'POST', {
      org_id: orgId,
      recipients: all.map((x) =>
        x.name.trim() ? { email: x.email, name: x.name.trim() } : { email: x.email },
      ),
    });
    setBusy(false);
    if (r.ok) {
      setResult({ sent: r.data.sent + r.data.resent, notSent: notSentOf(r.data) });
      update([]);
    } else {
      update(all, next.skipped);
      setResult(null);
      setError(t(failureKey(r)));
    }
  }

  let footNote: string | null = null;
  if (recipients.length === 0 && !draft.trim()) footNote = t('invite.note_empty');
  else if (invalidCount) footNote = t('invite.note_fix');

  let sendLabel = t('invite.send');
  if (busy) sendLabel = t('invite.sending');
  else if (valid.length) sendLabel = t('invite.send_count', { count: valid.length });

  let placeholder = t('invite.placeholder');
  if (full) placeholder = t('invite.limit_reached');
  else if (recipients.length) placeholder = t('invite.add_more');

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
      <ConsoleSection flush className="min-w-0 overflow-visible">
        <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col text-[13.5px]" noValidate>
          <OrgHeader orgs={orgs} orgId={orgId} onChange={setOrgId} />

          <div className="flex flex-1 flex-col gap-2.5 p-[22px]">
            {result ? <ResultBanner result={result} onDismiss={() => setResult(null)} /> : null}

            <div className="flex items-baseline justify-between gap-3">
              <label htmlFor="invite-emails" className="text-[14px] font-bold text-ink-900">
                {t('invite.recipients')}
              </label>
              <CountMeter count={recipients.length} max={maxRecipients} />
            </div>

            <div className="flex max-h-[180px] min-h-24 flex-wrap content-start items-center gap-2 overflow-auto rounded-[12px] border-[1.5px] border-(--bd-border) bg-(--bd-bg) p-3 transition-[border-color,box-shadow] focus-within:border-(--bd-primary) focus-within:bg-(--bd-card) focus-within:shadow-[0_0_0_4px_var(--bd-primary-50)]">
              {recipients.map((r) => (
                <span
                  key={r.email}
                  title={r.valid ? undefined : t('invite.reason.invalid_email')}
                  onDoubleClick={() => edit(r.email)}
                  className={cn(
                    'inline-flex h-8 max-w-full items-center gap-1.5 rounded-lg border pl-2.5 pr-1.5 text-[13.5px] font-medium',
                    r.valid
                      ? 'border-(--bd-primary-100) bg-(--bd-primary-50) text-(--bd-primary-600)'
                      : 'border-rose-200 bg-rose-50 text-rose-700',
                  )}
                >
                  <span className="truncate">{r.email}</span>
                  <button
                    type="button"
                    onClick={() => remove(r.email)}
                    className="grid h-[22px] w-[22px] place-items-center rounded-md opacity-70 hover:bg-black/5 hover:opacity-100"
                    aria-label={t('invite.remove', { email: r.email })}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              <input
                id="invite-emails"
                type="text"
                inputMode="email"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                value={draft}
                disabled={full}
                onChange={(e) => {
                  setDraft(e.target.value);
                  if (!e.target.value) setHeldName('');
                }}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
                onBlur={() => draft.trim() && add(draft)}
                placeholder={placeholder}
                aria-describedby="invite-emails-hint"
                className="h-8 min-w-[12rem] flex-1 bg-transparent px-1 text-[15px] text-ink-900 outline-none placeholder:text-ink-400"
              />
            </div>

            <span id="invite-emails-hint" className="text-[12.5px] text-ink-500">
              {t.rich('invite.recipients_hint', { kbd: renderKbd })}
            </span>

            {full ? <LimitNote skipped={skipped} max={maxRecipients} /> : null}

            {invalidCount ? (
              <InvalidBanner count={invalidCount} onRemove={() => update(valid)} />
            ) : null}

            {valid.length ? <NamesList people={valid} onName={setName} onRemove={remove} /> : null}

            {error ? (
              <p role="alert" className="text-rose-700">
                {error}
              </p>
            ) : null}
          </div>

          <footer className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-b-[14px] border-t border-(--bd-border-soft) bg-(--bd-bg) px-[22px] py-4">
            {footNote ? (
              <span className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-500">
                <Info size={14} aria-hidden="true" className="shrink-0" />
                {footNote}
              </span>
            ) : null}
            <div className="ml-auto flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row">
              {recipients.length ? (
                <Button
                  kind="ghost"
                  onClick={() => update([])}
                  className="w-full justify-center sm:w-auto"
                >
                  {t('invite.clear')}
                </Button>
              ) : null}
              <Button
                type="submit"
                disabled={
                  busy || !orgId || invalidCount > 0 || (valid.length === 0 && !draft.trim())
                }
                icon={<I.send size={15} />}
                className="w-full justify-center sm:w-auto"
              >
                {sendLabel}
              </Button>
            </div>
          </footer>
        </form>
      </ConsoleSection>

      <HelpCard maxRecipients={maxRecipients} coordinatorsHref={coordinatorsHref} />
    </div>
  );
}

/** The card header: the organisation (or a picker when there are several) and the role. */
function OrgHeader({
  orgs,
  orgId,
  onChange,
}: Readonly<{
  orgs: Array<{ id: string; name: string }>;
  orgId: string;
  onChange: (id: string) => void;
}>) {
  const t = useTranslations('console');
  const single = orgs.length === 1 ? orgs[0] : null;
  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-(--bd-border-soft) px-[22px] py-4">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-(--bd-primary-50) text-(--bd-primary-600)">
        <I.briefcase size={18} />
      </span>
      {single ? (
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[12px] text-ink-500">{t('invite.inviting_to')}</span>
          <span className="break-words text-[15px] font-bold text-ink-900">{single.name}</span>
        </span>
      ) : (
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-[12px] text-ink-500">{t('invite.org')}</span>
          <select className="bd-input" value={orgId} onChange={(e) => onChange(e.target.value)}>
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <span className="ml-auto rounded-full bg-(--bd-bg) px-2.5 py-1 text-[12px] font-semibold text-ink-700">
        {t('invite.role')}
      </span>
    </header>
  );
}

/** The one-line result after a send: how many went out and why the rest did not. */
function ResultBanner({
  result,
  onDismiss,
}: Readonly<{ result: { sent: number; notSent: NotSent[] }; onDismiss: () => void }>) {
  const t = useTranslations('console');
  const reasonText = (reason: string) =>
    t(`invite.reason.${KNOWN_REASONS.has(reason) ? reason : 'other'}`);
  return (
    <output className="flex items-start gap-3 rounded-[12px] bg-emerald-50 px-4 py-3 text-ink-700">
      <I.send size={16} className="mt-0.5 shrink-0 text-emerald-700" />
      <span className="min-w-0 flex-1">
        <span className="block font-semibold text-emerald-800">
          {t('invite.sent', { count: result.sent })}
        </span>
        {result.notSent.length ? (
          <span className="block break-words text-[13px] text-ink-500">
            {t('invite.not_sent')}{' '}
            {result.notSent.map((n) => `${n.email} (${reasonText(n.reason)})`).join(' · ')}
          </span>
        ) : null}
      </span>
      <button
        type="button"
        onClick={onDismiss}
        className="-m-1 rounded-lg p-2 text-ink-500 hover:bg-black/5"
        aria-label={t('invite.dismiss')}
      >
        <X className="h-4 w-4" />
      </button>
    </output>
  );
}

/** "N of max" with a small bar; amber once the list is full. */
function CountMeter({ count, max }: Readonly<{ count: number; max: number }>) {
  const t = useTranslations('console');
  const full = count >= max;
  return (
    <span
      className={cn(
        'flex items-center gap-2 text-[12.5px] font-semibold tabular-nums',
        full ? 'text-amber-700' : 'text-ink-500',
      )}
    >
      {t('invite.count', { count, max })}
      <span aria-hidden className="h-[5px] w-20 overflow-hidden rounded-full bg-(--bd-bg)">
        <span
          className={cn(
            'block h-full rounded-full transition-[width]',
            full ? 'bg-amber-600' : 'bg-(--bd-primary)',
          )}
          style={{ width: `${Math.min(100, (count / max) * 100)}%` }}
        />
      </span>
    </span>
  );
}

/** Says that only `max` can be sent at a time, and how many emails were not added. */
function LimitNote({ skipped, max }: Readonly<{ skipped: number; max: number }>) {
  const t = useTranslations('console');
  return (
    <output className="flex items-start gap-2.5 rounded-[10px] bg-(--bd-primary-50) px-3 py-2.5 text-[13px] text-(--bd-primary-600)">
      <Info size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span>
        {skipped
          ? t('invite.skipped_note', { max, count: skipped })
          : t('invite.limit_note', { max })}
      </span>
    </output>
  );
}

/** The count of invalid emails with a button that removes them all. */
function InvalidBanner({ count, onRemove }: Readonly<{ count: number; onRemove: () => void }>) {
  const t = useTranslations('console');
  return (
    <div className="flex items-start gap-2.5 rounded-[10px] bg-rose-50 px-3 py-2.5 text-[13px] text-rose-700">
      <I.alert size={16} className="mt-0.5 shrink-0" />
      <span>{t('invite.invalid_count', { count })}</span>
      <button
        type="button"
        onClick={onRemove}
        className="ml-auto whitespace-nowrap text-[12.5px] font-bold underline"
      >
        {t('invite.remove_invalid')}
      </button>
    </div>
  );
}

/** One row per valid email with an optional name for the greeting. */
function NamesList({
  people,
  onName,
  onRemove,
}: Readonly<{
  people: readonly Recipient[];
  onName: (email: string, name: string) => void;
  onRemove: (email: string) => void;
}>) {
  const t = useTranslations('console');
  return (
    <div className="mt-1.5 overflow-hidden rounded-[12px] border border-(--bd-border)">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-(--bd-border) bg-(--bd-bg) px-4 py-2.5">
        <span className="font-semibold text-ink-900">
          {t('invite.people', { count: people.length })}
        </span>
        <span className="text-[12px] text-ink-500">{t('invite.names_hint')}</span>
      </div>
      <ul>
        {people.map((r) => (
          <li
            key={r.email}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-2 border-b border-(--bd-border-soft) px-4 py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_14rem_auto]"
          >
            <span className="truncate text-ink-900">{r.email}</span>
            <input
              type="text"
              className="bd-input col-span-2 row-start-2 md:col-span-1 md:col-start-2 md:row-start-1"
              value={r.name}
              onChange={(e) => onName(r.email, e.target.value)}
              placeholder={t('invite.name_placeholder')}
              aria-label={t('invite.name_label', { email: r.email })}
            />
            <button
              type="button"
              onClick={() => onRemove(r.email)}
              className="col-start-2 row-start-1 -mr-3 grid h-11 w-11 place-items-center rounded-lg text-ink-500 hover:bg-black/5 md:col-start-3"
              aria-label={t('invite.remove', { email: r.email })}
            >
              <X className="h-4 w-4" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The side card: the three steps, a link to Coordinators, and the per-send limit. */
function HelpCard({
  maxRecipients,
  coordinatorsHref,
}: Readonly<{ maxRecipients: number; coordinatorsHref: string | null }>) {
  const t = useTranslations('console');
  return (
    <ConsoleSection flush>
      <aside aria-labelledby="invite-help-heading">
        <div className="p-5">
          <h2
            id="invite-help-heading"
            className="mb-3.5 text-[13px] font-bold uppercase tracking-[0.08em] text-ink-500"
          >
            {t('invite.help.heading')}
          </h2>
          <ol className="flex flex-col">
            {HELP_STEPS.map(({ key, Icon }, i) => (
              <li
                key={key}
                className="relative grid grid-cols-[32px_minmax(0,1fr)] gap-3 pb-[18px] last:pb-0"
              >
                {i < HELP_STEPS.length - 1 ? (
                  <span
                    aria-hidden
                    className="absolute bottom-0.5 left-[15px] top-[34px] w-0.5 bg-(--bd-border)"
                  />
                ) : null}
                <span
                  className={cn(
                    'grid h-8 w-8 place-items-center rounded-full',
                    i === 0
                      ? 'bg-(--bd-primary) text-white'
                      : 'bg-(--bd-primary-50) text-(--bd-primary-600)',
                  )}
                >
                  <Icon className="h-[15px] w-[15px]" />
                </span>
                <span className="min-w-0">
                  <span className="block pt-[5px] text-[13.5px] font-bold text-ink-900">
                    {t(`invite.help.${key}.title`)}
                  </span>
                  <span className="block text-[13px] text-ink-500">
                    {key === 'approve'
                      ? t.rich('invite.help.approve.body', { link: linkTo(coordinatorsHref) })
                      : t(`invite.help.${key}.body`)}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </div>
        <p className="border-t border-(--bd-border-soft) px-5 py-3.5 text-[12px] text-ink-500">
          {t('invite.help.limits', { max: maxRecipients })}
        </p>
      </aside>
    </ConsoleSection>
  );
}
