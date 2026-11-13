'use client';

/**
 * Re-grants an active organisation's owner sign-in access (user & org Phase
 * 5, `POST /v1/org/access/repair/:id`), from the organisation's page. For the
 * network admin only; the page decides whether to render it.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { OwnerAccessResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { Button } from '../ui/Button';
import { errorKey, sendConsole } from '../../lib/console-client';

/**
 * A "Re-grant owner access" button with its outcome.
 *
 * @param props.orgId - The organisation.
 */
export function OwnerAccessRepair({ orgId }: Readonly<{ orgId: string }>) {
  const t = useTranslations('console');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function repair() {
    setBusy(true);
    const r = await sendConsole<OwnerAccessResponse>(
      `/api/console/org/repair/${orgId}`,
      'POST',
      {},
    );
    setBusy(false);
    setNote(r.ok ? t('orgs.repaired', { status: r.data.status }) : t(errorKey(r)));
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button kind="ghost" disabled={busy} onClick={() => void repair()}>
        {t('orgs.repair')}
      </Button>
      {note ? <output className="text-[12.5px] text-ink-600">{note}</output> : null}
    </div>
  );
}
