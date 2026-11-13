'use client';

/**
 * A list of organisations awaiting their parent's decision, for the network
 * admin and for org owners. Each name opens the organisation, and a pending
 * org is approved or rejected in place; a rejection asks for a reason, which
 * is sent to the applicant. The page then refreshes so the lists follow. A 409 ALREADY_DECIDED response updates the row in
 * place. Owner access is repaired on the organisation's page.
 */

import { Fragment, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type {
  OrgDecisionResponse,
  OrgSearchResponse,
} from '@aggregator-dpg/shared-primitives/user-org';
import { Button } from '../ui/Button';
import { ConsoleStatusPill, EmptyState } from './ConsoleUi';
import { sendConsole } from '../../lib/console-client';
import { plainErrorKey } from '../../lib/console-errors';

type OrgRow = OrgSearchResponse['orgs'][number];

export function OrgsTable({ orgs }: Readonly<{ orgs: OrgRow[] }>) {
  const t = useTranslations('console');
  const router = useRouter();
  const [rows, setRows] = useState(orgs);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  // The row whose rejection is being written, and its reason.
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const note = (id: string, text: string) => setNotes((n) => ({ ...n, [id]: text }));
  const setStatus = (id: string, status: OrgRow['status']) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, status } : r)));

  async function decide(id: string, decision: 'approve' | 'reject') {
    setBusy(id);
    const body = decision === 'reject' ? { decision, reason: reason.trim() } : { decision };
    const r = await sendConsole<OrgDecisionResponse>(
      `/api/console/org/decision/${id}`,
      'POST',
      body,
    );
    setBusy(null);
    if (r.ok) {
      setRejecting(null);
      setReason('');
      setStatus(id, r.data.status);
      note(id, t('coordinator.decided'));
      router.refresh();
    } else if (r.error.code === 'ALREADY_DECIDED') {
      const status = r.error.fields?.['status'] as OrgRow['status'] | undefined;
      if (status) setStatus(id, status);
      note(id, t('coordinator.already', { status: status ? t(`status.${status}`) : '' }));
    } else {
      note(id, t(plainErrorKey(r, 'orgs')));
    }
  }

  // Decisions are the only row actions; the column shows while one is pending
  // or a decision has just been made.
  const showActions = rows.some((r) => r.status === 'pending' || notes[r.id]);
  const columns = showActions ? 6 : 5;

  if (rows.length === 0) return <EmptyState>{t('orgs.empty')}</EmptyState>;
  return (
    <div className="overflow-x-auto scroll-x">
      <table className="bd-table">
        <thead>
          <tr>
            <th>{t('orgs.col_name')}</th>
            <th>{t('orgs.col_known_as')}</th>
            <th>{t('orgs.col_parent')}</th>
            <th>{t('orgs.col_status')}</th>
            <th>{t('orgs.col_counts')}</th>
            {showActions ? <th style={{ textAlign: 'right' }}>{t('orgs.col_actions')}</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => (
            <Fragment key={o.id}>
              <tr>
                <td>
                  <Link
                    className="font-semibold text-primary-600 hover:underline"
                    href={`/console/orgs/${o.id}`}
                  >
                    {o.name}
                  </Link>
                  {notes[o.id] ? (
                    <output className="text-[12.5px] text-ink-500 mt-1 block whitespace-normal">
                      {notes[o.id]}
                    </output>
                  ) : null}
                </td>
                <td className="text-ink-600">{o.known_as_name ?? o.known_as ?? '—'}</td>
                <td className="text-ink-600">{o.parent_name ?? '—'}</td>
                <td>
                  <ConsoleStatusPill status={o.status} />
                </td>
                <td className="text-ink-600">
                  {t('home.coordinators', { count: o.coordinator_count })} ·{' '}
                  {t('home.pending', { count: o.pending_count })}
                </td>
                {showActions ? (
                  <td>
                    {o.status === 'pending' ? (
                      <div className="flex gap-2 justify-end">
                        <Button
                          disabled={busy === o.id}
                          onClick={() => void decide(o.id, 'approve')}
                        >
                          {t('orgs.approve')}
                        </Button>
                        <Button
                          kind="danger"
                          disabled={busy === o.id || rejecting === o.id}
                          onClick={() => {
                            setRejecting(o.id);
                            setReason('');
                          }}
                        >
                          {t('orgs.reject')}
                        </Button>
                      </div>
                    ) : null}
                  </td>
                ) : null}
              </tr>
              {rejecting === o.id && o.status === 'pending' ? (
                <tr>
                  <td colSpan={columns}>
                    <div className="flex flex-col gap-3 py-1 text-[13.5px]">
                      <label className="flex max-w-2xl flex-col gap-1.5">
                        <span className="bd-label">{t('orgs.reject_reason')}</span>
                        <textarea
                          className="bd-input min-h-[80px]"
                          maxLength={500}
                          required
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                        />
                      </label>
                      <div className="flex gap-2">
                        <Button
                          kind="danger"
                          disabled={busy === o.id || reason.trim() === ''}
                          onClick={() => void decide(o.id, 'reject')}
                        >
                          {t('orgs.reject_confirm')}
                        </Button>
                        <Button
                          kind="ghost"
                          disabled={busy === o.id}
                          onClick={() => {
                            setRejecting(null);
                            setReason('');
                          }}
                        >
                          {t('coordinator.cancel')}
                        </Button>
                      </div>
                    </div>
                  </td>
                </tr>
              ) : null}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
