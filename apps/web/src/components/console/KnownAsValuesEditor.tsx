'use client';

/**
 * Editor for the "known as" values an organisation defines for the
 * organisations directly under it.
 *
 * Each row has a name and a "default" radio. The API makes each new value's
 * key from its name; a saved value sends its key back, so a rename keeps the
 * organisations that use it linked. Removing a value resets the organisations
 * that use it to the default value, else to "Aggregator".
 */

import { useState, type SubmitEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import {
  KNOWN_AS_MAX_VALUES,
  KNOWN_AS_NAME_MAX,
  type KnownAsValues,
  type KnownAsEntryRequest,
} from '@aggregator-dpg/shared-primitives/user-org';
import { Button } from '../ui/Button';
import { I } from '../../icons';
import { cn } from '../../lib/cn';
import { errorKey, setOrgKnownAsValues } from '../../lib/console-client';

/** One row of the editor. `key` is set for a saved value only. */
interface Row {
  /** Local id for React keys and the default choice. */
  id: number;
  key?: string;
  name: string;
}

let nextRowId = 0;

/** The rows and the default row's id for a saved list. */
function rowsOf(values: KnownAsValues): { rows: Row[]; defaultId: number | null } {
  let defaultId: number | null = null;
  const rows = values.map((v) => {
    const row: Row = { id: ++nextRowId, key: v.key, name: v.name };
    if (v.default) defaultId = row.id;
    return row;
  });
  return { rows, defaultId };
}

/** The request body entries for the rows. */
function toRequest(rows: readonly Row[], defaultId: number | null): KnownAsEntryRequest[] {
  return rows.map((r) => ({
    ...(r.key ? { key: r.key } : {}),
    name: r.name.trim(),
    ...(r.id === defaultId ? { default: true as const } : {}),
  }));
}

/** The request body entries that would save `values` unchanged. */
function requestOfSaved(values: KnownAsValues): KnownAsEntryRequest[] {
  return values.map((v) => ({
    key: v.key,
    name: v.name,
    ...(v.default ? { default: true as const } : {}),
  }));
}

/** Whether two saved lists have the same keys, names and default, in order. */
function sameList(a: KnownAsValues, b: KnownAsValues): boolean {
  return JSON.stringify(requestOfSaved(a)) === JSON.stringify(requestOfSaved(b));
}

/** Pills shown in the header before the rest collapse into "+N more". */
const PILLS_SHOWN = 3;

/**
 * The saved values as pills, the default first and highlighted, for a section
 * header; past {@link PILLS_SHOWN} the rest show as "+N more".
 *
 * @param values - The saved list.
 */
export function KnownAsPills({ values }: Readonly<{ values: KnownAsValues }>) {
  const t = useTranslations('console');
  const pill = 'rounded-full px-2.5 py-0.5 text-[12px] font-semibold';
  const def = 'bg-(--bd-primary-50) text-(--bd-primary-600)';
  const ordered = [...values].sort((a, b) => Number(!!b.default) - Number(!!a.default));
  const shown = ordered.slice(0, PILLS_SHOWN);
  const hidden = ordered.slice(PILLS_SHOWN);
  return (
    <span className="flex flex-wrap items-center justify-end gap-2 text-[12.5px] text-ink-500">
      <span className="whitespace-nowrap">{t('orgs.known_as_current')}</span>
      {values.length === 0 ? (
        <span className={cn(pill, def)}>{t('org.known_as_values_fallback')}</span>
      ) : (
        shown.map((v) => (
          <span key={v.key} className={cn(pill, v.default ? def : 'bg-ink-100 text-ink-700')}>
            {v.name}
          </span>
        ))
      )}
      {hidden.length > 0 ? (
        <span
          className={cn(pill, 'bg-ink-100 text-ink-700')}
          title={hidden.map((v) => v.name).join(', ')}
        >
          {t('org.known_as_values_more', { count: hidden.length })}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Renders the editor for an organisation's `known_as_values` list.
 *
 * @param orgId - The organisation that defines the list (the root for the network).
 * @param values - The saved list.
 */
export function KnownAsValuesEditor({
  orgId,
  values,
}: Readonly<{
  orgId: string;
  values: KnownAsValues;
}>) {
  const t = useTranslations('console');
  const router = useRouter();
  const [saved, setSaved] = useState(values);
  const [state, setState] = useState(() => rowsOf(values));
  const [draft, setDraft] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const { rows, defaultId } = state;

  // A list from the page with different keys, names or default replaces the
  // editor's copy. The same list in a new object keeps unsaved edits.
  const [seen, setSeen] = useState(values);
  if (values !== seen && !sameList(values, seen)) {
    setSeen(values);
    setSaved(values);
    setState(rowsOf(values));
  }

  const dirty =
    JSON.stringify(toRequest(rows, defaultId)) !== JSON.stringify(requestOfSaved(saved));
  const full = rows.length >= KNOWN_AS_MAX_VALUES;
  const radioName = `known-as-values-default-${orgId}`;
  const label = t('org.known_as_values_short');

  function update(next: Partial<typeof state>) {
    setState((s) => ({ ...s, ...next }));
    setMessage(null);
  }

  function rename(id: number, name: string) {
    update({ rows: rows.map((r) => (r.id === id ? { ...r, name } : r)) });
  }

  /** Removes a row; a saved value asks first, since its orgs move on save. */
  function remove(id: number) {
    const row = rows.find((r) => r.id === id);
    if (row?.key && confirmId !== id) {
      setConfirmId(id);
      return;
    }
    setConfirmId(null);
    update({
      rows: rows.filter((r) => r.id !== id),
      defaultId: defaultId === id ? null : defaultId,
    });
  }

  function add() {
    const name = draft.trim();
    if (!name || full) return;
    if (rows.some((r) => r.name.trim().toLowerCase() === name.toLowerCase())) {
      setAddError(t('org.known_as_values_exists', { name }));
      return;
    }
    const row = { id: ++nextRowId, name };
    update({ rows: [...rows, row], defaultId: rows.length === 0 ? row.id : defaultId });
    setDraft('');
  }

  function discard() {
    setConfirmId(null);
    setState(rowsOf(saved));
    setMessage(null);
    setAddError(null);
  }

  /** The message key of the first problem in the rows, or null. */
  function problem(): string | null {
    const names = rows.map((r) => r.name.trim().toLowerCase());
    if (names.some((n) => n === '')) return 'org.known_as_values_name_required';
    if (new Set(names).size !== names.length) return 'org.known_as_values_name_repeated';
    return null;
  }

  async function onSubmit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const bad = problem();
    if (bad) {
      setMessage(t(bad));
      return;
    }
    setBusy(true);
    const r = await setOrgKnownAsValues(orgId, toRequest(rows, defaultId));
    setBusy(false);
    if (r.ok) {
      setSaved(r.data.known_as_values);
      setState(rowsOf(r.data.known_as_values));
      const moved = r.data.reset_count ?? 0;
      setMessage(
        moved > 0 ? t('org.known_as_values_saved_reset', { count: moved }) : t('org.saved'),
      );
      router.refresh();
      return;
    }
    setMessage(t(errorKey(r)));
  }

  let status = message;
  if (!status)
    status = dirty ? t('org.known_as_values_unsaved') : t('org.known_as_values_unchanged');

  return (
    <form noValidate onSubmit={(e) => void onSubmit(e)}>
      {/* Disabled while saving: the saved list replaces the rows, so an edit
          made meanwhile would be lost. */}
      <fieldset disabled={busy} className="min-w-0">
        <div className="grid lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="flex min-w-0 flex-col gap-[18px] p-6">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h3 className="text-[14px] font-bold text-ink-900">{label}</h3>
              <span className="text-[12.5px] text-ink-500">
                {t('org.known_as_values_select_default')}
              </span>
            </div>

            {rows.length === 0 ? (
              <p className="rounded-[12px] border border-dashed border-(--bd-border) px-3.5 py-3 text-[13px] text-ink-500">
                {t('org.known_as_values_empty')}
              </p>
            ) : (
              <div
                role="radiogroup"
                aria-label={label}
                className="max-h-[420px] overflow-y-auto overscroll-contain rounded-[12px] border border-(--bd-border)"
              >
                {rows.map((r, i) => {
                  const name = r.name.trim() || t('org.known_as_values_value', { n: i + 1 });
                  const isDefault = defaultId === r.id;
                  const fallback = isDefault
                    ? null
                    : rows.find((x) => x.id === defaultId)?.name.trim() || null;
                  return (
                    <div
                      key={r.id}
                      className="grid min-h-[52px] grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 border-t border-(--bd-border) py-2.5 pr-3 pl-3.5 first:border-t-0"
                    >
                      <input
                        type="radio"
                        className="h-[18px] w-[18px] accent-(--bd-primary)"
                        aria-label={t('org.known_as_values_make_default', { name })}
                        name={radioName}
                        checked={isDefault}
                        onChange={() => update({ defaultId: r.id })}
                      />
                      <input
                        aria-label={t('org.known_as_values_name', { n: i + 1 })}
                        className="w-full min-w-0 rounded-lg border border-transparent bg-transparent px-2 py-1.5 font-semibold text-ink-900 outline-none hover:border-(--bd-border) focus:border-(--bd-primary) focus:bg-(--bd-card)"
                        value={r.name}
                        maxLength={KNOWN_AS_NAME_MAX}
                        onChange={(e) => rename(r.id, e.target.value)}
                      />
                      <span className="min-w-[4rem] text-right">
                        {isDefault ? (
                          <span className="rounded-full bg-(--bd-primary-50) px-2 py-0.5 text-[11px] font-bold text-(--bd-primary-600)">
                            {t('org.known_as_values_default')}
                          </span>
                        ) : null}
                      </span>
                      <button
                        type="button"
                        aria-label={t('org.known_as_values_remove', { name })}
                        onClick={() => remove(r.id)}
                        className="grid h-8 w-8 place-items-center rounded-lg text-ink-400 hover:bg-rose-50 hover:text-rose-600"
                      >
                        <X size={15} aria-hidden="true" />
                      </button>
                      {confirmId === r.id ? (
                        <div
                          role="alert"
                          className="col-span-full flex flex-wrap items-center gap-2.5 rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-ink-700"
                        >
                          <span className="min-w-[200px] flex-1">
                            {t('org.known_as_values_remove_warning', {
                              name,
                              target: fallback ?? t('org.known_as_values_fallback'),
                            })}
                          </span>
                          <Button kind="ghost" onClick={() => setConfirmId(null)}>
                            {t('org.known_as_values_cancel')}
                          </Button>
                          <Button kind="danger" onClick={() => remove(r.id)}>
                            {t('org.known_as_values_remove_confirm')}
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <div className="flex gap-2">
                <input
                  aria-label={t('org.known_as_values_new')}
                  placeholder={t('org.known_as_values_placeholder')}
                  className="bd-input min-w-0 flex-1"
                  value={draft}
                  maxLength={KNOWN_AS_NAME_MAX}
                  disabled={full}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    setAddError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      add();
                    }
                  }}
                />
                <Button
                  kind="ghost"
                  className="border border-(--bd-border)"
                  icon={<I.plus size={14} aria-hidden="true" />}
                  disabled={full || !draft.trim()}
                  onClick={add}
                >
                  {t('org.known_as_values_add')}
                </Button>
              </div>
              {addError ? <p className="text-[12.5px] text-rose-600">{addError}</p> : null}
              {full ? (
                <p className="text-[12px] text-ink-500">
                  {t('org.known_as_values_max', { max: KNOWN_AS_MAX_VALUES })}
                </p>
              ) : null}
            </div>
          </div>

          <aside className="flex flex-col gap-3.5 border-t border-(--bd-border-soft) bg-(--bd-bg) p-6 lg:border-t-0 lg:border-l">
            <h4 className="text-[11px] font-bold uppercase tracking-[0.12em] text-ink-400">
              {t('org.known_as_values_notes_heading')}
            </h4>
            <ul className="flex flex-col gap-2 text-[12.5px] text-ink-500">
              {(['note_default', 'note_assign', 'remove_note'] as const).map((k) => (
                <li key={k} className="grid grid-cols-[14px_1fr] gap-2">
                  <span
                    aria-hidden
                    className="mt-[7px] ml-1 h-[5px] w-[5px] rounded-full bg-ink-400"
                  />
                  <span>{t(`org.known_as_values_${k}`)}</span>
                </li>
              ))}
            </ul>
          </aside>
        </div>

        <footer className="flex items-center gap-3 border-t border-(--bd-border-soft) px-6 py-3.5">
          <output
            className={cn(
              'mr-auto inline-flex items-center gap-2 text-[13px]',
              dirty && !message ? 'font-semibold text-amber-700' : 'text-ink-500',
            )}
          >
            {dirty && !message ? (
              <span aria-hidden className="h-[7px] w-[7px] rounded-full bg-amber-500" />
            ) : null}
            {status}
          </output>
          {dirty ? (
            <Button kind="ghost" onClick={discard}>
              {t('org.known_as_values_discard')}
            </Button>
          ) : null}
          <Button type="submit" disabled={busy || !dirty}>
            {t('org.known_as_values_save')}
          </Button>
        </footer>
      </fieldset>
    </form>
  );
}
