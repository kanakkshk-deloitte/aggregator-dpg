'use client';

/**
 * Picker for an organisation's "known as" value, for the owner of its parent.
 *
 * The choices are the parent's values, or only "Aggregator" when the parent
 * has none. The current value always shows, marked as no longer offered when
 * it is not among the choices.
 */

import { useState, type SubmitEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  knownAsChoices,
  type KnownAsEntry,
  type Org,
} from '@aggregator-dpg/shared-primitives/user-org';
import { Button } from '../ui/Button';
import { Label } from '../ui/Label';
import { errorKey, setOrgKnownAs } from '../../lib/console-client';

/**
 * Renders the "known as" picker.
 *
 * @param org - The organisation whose value is set. At depth 1 the network's values apply.
 * @param parentValues - The parent's stored list, from `org.parent.known_as_values`.
 */
export function KnownAsPicker({
  org,
  parentValues,
}: Readonly<{
  org: Pick<Org, 'id' | 'known_as' | 'known_as_name' | 'parent_name' | 'depth'>;
  parentValues: readonly KnownAsEntry[];
}>) {
  const t = useTranslations('console');
  const router = useRouter();
  const [current, setCurrent] = useState({ key: org.known_as, name: org.known_as_name });
  const [selected, setSelected] = useState(org.known_as ?? '');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A newer value from the page (after a refresh) replaces the picker's copy.
  const [seen, setSeen] = useState(org.known_as);
  if (org.known_as !== seen) {
    setSeen(org.known_as);
    setCurrent({ key: org.known_as, name: org.known_as_name });
    setSelected(org.known_as ?? '');
  }

  const options = knownAsChoices(parentValues);
  const currentListed = options.some((o) => o.key === current.key);

  async function onSubmit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    if (selected === '' || selected === current.key) return;
    setBusy(true);
    const r = await setOrgKnownAs(org.id, selected);
    setBusy(false);
    if (r.ok) {
      setCurrent({ key: r.data.known_as, name: r.data.known_as_name });
      setSelected(r.data.known_as ?? '');
      setMessage(t('org.saved'));
      router.refresh();
      return;
    }
    setMessage(t(errorKey(r)));
  }

  return (
    <form
      noValidate
      onSubmit={(e) => void onSubmit(e)}
      className="flex flex-col gap-3 sm:max-w-[50%]"
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="org-known-as-pick">{t('org.known_as')}</Label>
        <select
          id="org-known-as-pick"
          className="bd-input"
          value={selected}
          onChange={(e) => {
            setSelected(e.target.value);
            setMessage(null);
          }}
        >
          {currentListed || current.key === null ? null : (
            <option value={current.key}>
              {t('org.known_as_pick_unlisted', { name: current.name ?? current.key })}
            </option>
          )}
          {options.map((o) => (
            <option key={o.key} value={o.key}>
              {o.name}
            </option>
          ))}
        </select>
        <span className="text-[12px] text-ink-500">
          {org.depth === 1 || !org.parent_name
            ? t('org.known_as_pick_hint_network')
            : t('org.known_as_pick_hint', { parent: org.parent_name })}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={busy || selected === '' || selected === current.key}>
          {t('org.save')}
        </Button>
        {message ? <output className="text-[13px] text-ink-600">{message}</output> : null}
      </div>
    </form>
  );
}
