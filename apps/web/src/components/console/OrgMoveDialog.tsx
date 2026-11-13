'use client';

/**
 * "Move" action on the organisation page (network admin): moves an
 * organisation, with every organisation below it, under a new parent.
 *
 * The dialog reads the candidate parents when it opens. A candidate the move
 * would fail for is disabled and shows the reason. The moved org keeps its
 * "known as" value when the new parent's list has it; otherwise the API gives
 * it the new parent's default.
 */

import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { FolderInput } from 'lucide-react';
import type { OrgParentOptionsResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { Button } from '../ui/Button';
import { Label } from '../ui/Label';
import { errorKey, sendConsole, type ConsoleError } from '../../lib/console-client';

type ParentOption = OrgParentOptionsResponse['options'][number];

/** Message keys for the reasons a candidate parent is refused. */
const REASONS: Record<string, string> = {
  INVALID_PARENT: 'org.move_reason_invalid',
  PARENT_CYCLE: 'org.move_reason_cycle',
  CHILD_LIMIT: 'org.move_reason_full',
  DEPTH_LIMIT: 'org.move_reason_depth',
};

/**
 * Renders the "Move" button and, when open, the move dialog.
 *
 * @param orgId - The organisation to move.
 * @param orgName - Its name, for the dialog title.
 * @param parentId - Its current parent, marked in the list.
 */
export function OrgMoveDialog({
  orgId,
  orgName,
  parentId,
}: Readonly<{
  orgId: string;
  orgName: string;
  parentId: string | null;
}>) {
  const t = useTranslations('console');
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        kind="soft"
        icon={<FolderInput size={15} aria-hidden="true" />}
        onClick={() => setOpen(true)}
      >
        {t('org.move')}
      </Button>
      {open ? (
        <MoveDialog
          orgId={orgId}
          orgName={orgName}
          currentParentId={parentId}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

/** The open dialog: candidate parents and the submit. */
function MoveDialog({
  orgId,
  orgName,
  currentParentId,
  onClose,
}: Readonly<{
  orgId: string;
  orgName: string;
  currentParentId: string | null;
  onClose: () => void;
}>) {
  const t = useTranslations('console');
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<OrgParentOptionsResponse | null>(null);
  const [parentId, setParentId] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Native <dialog> gives focus trapping, focus restore, and Esc-to-close.
  useEffect(() => {
    const el = dialogRef.current;
    el?.showModal?.();
    return () => el?.close?.();
  }, []);

  useEffect(() => {
    let live = true;
    void (async () => {
      let status = 0;
      let error: ConsoleError = {};
      try {
        const res = await fetch(`/api/console/org/parent/options/${orgId}`, {
          credentials: 'same-origin',
        });
        const body = (await res.json().catch(() => null)) as unknown;
        if (res.ok) {
          if (live) setData(body as OrgParentOptionsResponse);
          return;
        }
        status = res.status;
        error = (body as { error?: ConsoleError } | null)?.error ?? {};
      } catch {
        // Network failure: reported as a generic error below.
      }
      if (live) setMessage(t(errorKey({ status, error })));
    })();
    return () => {
      live = false;
    };
  }, [orgId, t]);

  const parent = data?.options.find((o) => o.id === parentId);
  const ready = parent !== undefined;

  const optionText = (o: ParentOption) => {
    const label = o.known_as_name ? `${o.name} (${o.known_as_name})` : o.name;
    const name = o.id === currentParentId ? `${label} — ${t('org.move_current')}` : label;
    if (o.ok) return name;
    return `${name} — ${t(REASONS[o.reason ?? ''] ?? 'org.move_reason_other')}`;
  };

  async function onSubmit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    const r = await sendConsole(`/api/console/org/parent/${orgId}`, 'PATCH', {
      parent_id: parentId,
    });
    setBusy(false);
    if (r.ok) {
      dialogRef.current?.close?.();
      onClose();
      router.refresh();
    } else {
      setMessage(t(errorKey(r)));
    }
  }

  return (
    <dialog
      ref={dialogRef}
      aria-label={t('org.move_title', { name: orgName })}
      // Escape fires "cancel". The effect cleanup's close() also fires "close",
      // so closing the React state on "close" would unmount the dialog at once.
      onCancel={onClose}
      className="m-auto w-full max-w-[460px] rounded-[14px] bg-white p-5 shadow-xl backdrop:bg-black/40"
    >
      <h3 className="mb-3 font-display text-[15px] font-bold text-ink-900">
        {t('org.move_title', { name: orgName })}
      </h3>
      <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-4">
        {data ? (
          <>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="move-parent">{t('org.move_parent')}</Label>
              <select
                id="move-parent"
                className="bd-input"
                value={parentId}
                aria-required
                onChange={(e) => {
                  setParentId(e.target.value);
                  setMessage(null);
                }}
              >
                <option value="">{t('org.move_parent_placeholder')}</option>
                {data.options.map((o) => (
                  <option key={o.id} value={o.id} disabled={!o.ok}>
                    {optionText(o)}
                  </option>
                ))}
              </select>
            </div>
            <p className="text-[12px] text-ink-500">{t('org.move_hint_known_as')}</p>
            <p className="text-[13px] text-ink-600">
              {t('org.move_count', { count: data.subtree_size })}
            </p>
          </>
        ) : message ? null : (
          <p className="text-[13px] text-ink-500">{t('org.move_loading')}</p>
        )}
        {message ? <output className="text-[13px] text-rose-600">{message}</output> : null}
        <div className="flex items-center justify-end gap-3">
          <Button
            kind="ghost"
            onClick={() => {
              dialogRef.current?.close?.();
              onClose();
            }}
          >
            {t('org.move_cancel')}
          </Button>
          <Button type="submit" disabled={busy || !ready}>
            {t('org.move_submit')}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
