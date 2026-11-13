'use client';

import { useMemo, useState, type JSX, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { RegisterPageShell } from '../RegisterPageShell';
import { DEFAULT_MAX_INVITES } from '../../../../lib/invite-limit';

export interface OwnerInviteViewProps {
  /** The owner grant token from the deep-link query string. */
  grant: string;
  /**
   * Max invites per submission; should match the API's `INVITE_MINT_MAX_RECIPIENTS`.
   * Resolved by the server page so it can change without a rebuild.
   */
  maxInvites?: number;
}

interface MintSummary {
  /** True when the grant was expired and a fresh link was re-mailed (nothing minted). */
  recovered: boolean;
  sent: number;
  resent: number;
  invalid: Array<{ email: string; reason: string }>;
}

type ViewState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'result'; summary: MintSummary }
  | { status: 'recovery_sent' } // expired grant; a fresh link was emailed
  | { status: 'invalid_grant' }
  | { status: 'error'; message: string };

interface InviteRow {
  /** Stable client-side id for the React key (rows are reorderable/removable). */
  id: string;
  name: string;
  email: string;
}

let rowSeq = 0;
/** Builds a fresh empty row with a stable id (avoids array-index keys). */
function newRow(): InviteRow {
  rowSeq += 1;
  return { id: `row-${rowSeq}`, name: '', email: '' };
}

/**
 * Owner page for inviting coordinators.
 *
 * Takes one email and optional name per coordinator, sends the invites, and
 * shows a summary (sent, re-sent, invalid). An expired grant shows a banner
 * saying a fresh link was emailed to the owner.
 *
 * @param props - The grant token from the deep link, and the per-submission cap.
 * @returns The invite-management page body.
 */
export function OwnerInviteView({
  grant,
  maxInvites = DEFAULT_MAX_INVITES,
}: Readonly<OwnerInviteViewProps>): JSX.Element {
  const t = useTranslations('register.owner_invite');
  const [rows, setRows] = useState<InviteRow[]>([newRow()]);
  const [state, setState] = useState<ViewState>({ status: 'idle' });

  // Only rows with an email are sent; the optional name greets the recipient.
  const recipients = useMemo(
    () =>
      rows
        .map((r) => ({ email: r.email.trim(), name: r.name.trim() }))
        .filter((r) => r.email.length > 0)
        .map((r) => (r.name ? { email: r.email, name: r.name } : { email: r.email })),
    [rows],
  );
  const canSubmit = recipients.length > 0 && state.status !== 'submitting';
  const plural = recipients.length === 1 ? '' : 's';
  const sendLabel =
    state.status === 'submitting'
      ? 'Sending…'
      : `Send ${recipients.length || ''} invite${plural}`.trim();

  function updateRow(index: number, field: keyof InviteRow, value: string): void {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
  }
  function addRow(): void {
    setRows((prev) => (prev.length >= maxInvites ? prev : [...prev, newRow()]));
  }
  function removeRow(index: number): void {
    setRows((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== index)));
  }

  async function submit(): Promise<void> {
    setState({ status: 'submitting' });
    let res: Response;
    try {
      res = await fetch('/api/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant, recipients }),
      });
    } catch {
      setState({ status: 'error', message: 'Network error. Please try again.' });
      return;
    }
    if (res.ok) {
      const summary = (await res.json()) as MintSummary;
      // An expired grant emails a fresh link and sends no invites.
      setState(summary.recovered ? { status: 'recovery_sent' } : { status: 'result', summary });
      if (!summary.recovered) setRows([newRow()]);
      return;
    }
    const code = await readErrorCode(res);
    if (code === 'GRANT_INVALID') {
      setState({ status: 'invalid_grant' });
    } else if (res.status === 429) {
      setState({
        status: 'error',
        message: 'Too many invites just now. Please try again shortly.',
      });
    } else {
      setState({ status: 'error', message: 'Could not send invites. Please try again.' });
    }
  }

  return (
    <RegisterPageShell heading={t('heading')} tagline={null}>
      <div className="mt-6">
        {state.status === 'invalid_grant' ? (
          <Banner tone="error">
            This invite-management link is not valid. Please use the link from your approval email.
          </Banner>
        ) : null}

        {state.status === 'recovery_sent' ? (
          <Banner tone="warn">
            This invite-management link had expired, so we&apos;ve emailed a fresh one to your
            registered address. Open that link and try again.
          </Banner>
        ) : null}

        {state.status === 'result' ? (
          <ResultPanel summary={state.summary} onAgain={() => setState({ status: 'idle' })} />
        ) : null}

        {state.status === 'error' ? <Banner tone="error">{state.message}</Banner> : null}

        {state.status === 'idle' || state.status === 'submitting' ? (
          <>
            <p className="text-[14px] text-ink-500 mb-4">
              Add a coordinator&apos;s email (and optionally their name). Each person gets their own
              one-time invite. Use &ldquo;Add another&rdquo; to invite more than one.
            </p>

            <div className="space-y-3">
              {rows.map((row, i) => (
                <div key={row.id} className="flex items-start gap-2">
                  <div className="grid flex-1 gap-2 sm:grid-cols-2">
                    <input
                      type="email"
                      inputMode="email"
                      aria-label={t('email_label', { n: i + 1 })}
                      placeholder="email@org.in"
                      value={row.email}
                      onChange={(e) => updateRow(i, 'email', e.target.value)}
                      className="rounded-[10px] border border-ink-200 bg-white px-3.5 py-2.5 text-[14px] focus:border-(--bd-primary) focus:outline-none"
                    />
                    <input
                      type="text"
                      aria-label={t('name_label', { n: i + 1 })}
                      placeholder="Name (optional)"
                      value={row.name}
                      onChange={(e) => updateRow(i, 'name', e.target.value)}
                      className="rounded-[10px] border border-ink-200 bg-white px-3.5 py-2.5 text-[14px] focus:border-(--bd-primary) focus:outline-none"
                    />
                  </div>
                  {rows.length > 1 ? (
                    <button
                      type="button"
                      aria-label={t('remove_label', { n: i + 1 })}
                      onClick={() => removeRow(i)}
                      className="mt-1 rounded-[8px] px-2 py-1.5 text-[18px] leading-none text-ink-400 hover:bg-ink-50 hover:text-ink-600"
                    >
                      ×
                    </button>
                  ) : null}
                </div>
              ))}
            </div>

            <div className="mt-3 flex items-center gap-3">
              {rows.length < maxInvites ? (
                <button
                  type="button"
                  onClick={addRow}
                  className="text-[13.5px] font-semibold text-(--bd-primary-600) hover:underline"
                >
                  + Add another
                </button>
              ) : null}
              <span className="text-[12.5px] text-ink-400">Up to {maxInvites} at a time.</span>
            </div>

            <div className="mt-5 flex items-center gap-3">
              <button
                type="button"
                disabled={!canSubmit}
                onClick={submit}
                className="rounded-[10px] bg-(--bd-primary) px-5 py-2.5 text-[14px] font-semibold text-white disabled:opacity-50"
              >
                {sendLabel}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </RegisterPageShell>
  );
}

function ResultPanel({
  summary,
  onAgain,
}: Readonly<{ summary: MintSummary; onAgain: () => void }>): JSX.Element {
  const total = summary.sent + summary.resent;
  const n = (c: number, w: string): string => `${c} ${w}${c === 1 ? '' : 's'}`;

  let headline = 'No new invites sent';
  if (summary.sent > 0) headline = `${n(summary.sent, 'invite')} sent`;
  else if (summary.resent > 0) headline = `${n(summary.resent, 'invite')} re-sent`;

  return (
    <div className="space-y-4">
      <div className="rounded-[12px] border border-emerald-200 bg-emerald-50 px-5 py-4">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500 text-[13px] font-bold text-white"
          >
            ✓
          </span>
          <p className="text-[15px] font-semibold text-emerald-900">{headline}</p>
        </div>
        {total > 0 ? (
          <p className="mt-2 text-[13.5px] text-emerald-800">
            Each coordinator got an email with their own one-time link to register.
            {summary.resent > 0 && summary.sent > 0
              ? ` ${n(summary.resent, 'address')} already had a pending invite — we re-sent it.`
              : ''}
          </p>
        ) : null}
      </div>

      {summary.invalid.length > 0 ? (
        <div className="rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
          <p className="font-semibold">
            {n(summary.invalid.length, 'address')} couldn&apos;t be invited:
          </p>
          <ul className="mt-1 space-y-0.5">
            {summary.invalid.map((i) => (
              <li key={`${i.email}:${i.reason}`}>
                {i.email} — {i.reason.replaceAll('_', ' ')}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <button
        type="button"
        onClick={onAgain}
        className="text-[14px] font-semibold text-(--bd-primary-600) hover:underline"
      >
        Invite more coordinators
      </button>
    </div>
  );
}

const TONE_CLS: Record<'success' | 'warn' | 'error', string> = {
  success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  warn: 'border-amber-200 bg-amber-50 text-amber-800',
  error: 'border-red-200 bg-red-50 text-red-700',
};

function Banner({
  tone,
  children,
}: Readonly<{ tone: 'success' | 'warn' | 'error'; children: ReactNode }>): JSX.Element {
  return (
    <output
      className={`mb-4 block rounded-[10px] border px-4 py-3 text-[13.5px] ${TONE_CLS[tone]}`}
    >
      {children}
    </output>
  );
}

/** Reads the error code from the response body, or `null` for a non-JSON body. */
async function readErrorCode(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: { code?: string } };
    return body.error?.code ?? null;
  } catch {
    return null;
  }
}
