'use client';

/**
 * Organisation details form. Two parts:
 *
 * - Fixed fields: name, legal name and description (inputs), the "known as"
 *   value, and locations (shown).
 * - Schema fields: whatever the deployment's org-registration schema lists
 *   (e.g. website, GST number, domains), drawn by RJSF. Fields marked
 *   `x-updatable` are editable; the others are shown read-only.
 *
 * Only the org's owner edits the details, the name included. The "known as"
 * value is shown read-only here; the owner of the parent org sets it with
 * `KnownAsPicker`. When the page shows that picker, this form leaves the value
 * out. The network admin sees the details read-only. The Default
 * org, the root and an org below the viewer's own are read-only.
 */

import { useMemo, useRef, useState, type ReactNode, type SubmitEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type Form from '@rjsf/core';
import type { ErrorSchema, RJSFSchema, UiSchema } from '@rjsf/utils';
import type { Org } from '@aggregator-dpg/shared-primitives/user-org';
import { Button } from '../ui/Button';
import { I } from '../../icons';
import { ConsoleSection, DetailList } from './ConsoleUi';
import { Input } from '../ui/Input';
import { Label } from '../ui/Label';
import { RjsfThemedForm } from '../forms/RjsfThemed';
import { errorKey, sendConsole } from '../../lib/console-client';
import { consoleOrgSchema, gstinCustomValidate, orgFieldText } from '../../lib/org-schema';
import { readableFormErrors } from '../../lib/readable-form-errors';

/** Longest description the API accepts. */
const DESCRIPTION_MAX = 1000;

type JsonRecord = Record<string, unknown>;

/** Trimmed value, or null when blank (clears the field). */
const orNull = (v: string) => (v.trim() ? v.trim() : null);

/** The "known as" name, or the key when the name is missing. */
const knownAsText = (o: Org) => o.known_as_name ?? o.known_as ?? '—';

/** Whether a schema value is empty (cleared). */
const isEmpty = (v: unknown) =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/** Whether two schema values are the same (order of a list counts). */
const sameValue = (a: unknown, b: unknown) =>
  (isEmpty(a) && isEmpty(b)) || JSON.stringify(a) === JSON.stringify(b);

/** The values of `fields` in `profile`. */
function pick(profile: JsonRecord, fields: readonly string[]): JsonRecord {
  return Object.fromEntries(fields.filter((f) => f in profile).map((f) => [f, profile[f]]));
}

export function OrgEditForm({
  org,
  editable,
  canEdit,
  orgSchema,
  knownAsPicked = false,
}: Readonly<{
  org: Org;
  /** False for the Default org, the root and an org below the viewer's own. */
  editable: boolean;
  /** The signed-in user owns this org: every detail but "known as". */
  canEdit: boolean;
  /** The deployment's org-registration schema (network domains applied); `null` if unavailable. */
  orgSchema: { schema: RJSFSchema; uiSchema: JsonRecord } | null;
  /** The page shows `KnownAsPicker` for this org, so the form leaves "known as" out. */
  knownAsPicked?: boolean;
}>) {
  const t = useTranslations('console');
  const router = useRouter();
  const editing = editable && canEdit;
  const view = useMemo(
    () => (orgSchema ? consoleOrgSchema(orgSchema.schema, orgSchema.uiSchema, editing) : null),
    [orgSchema, editing],
  );
  const fields = useMemo(() => Object.keys((view?.schema.properties ?? {}) as JsonRecord), [view]);
  const customValidate = useMemo(
    () => (view ? gstinCustomValidate(view.schema) : undefined),
    [view],
  );

  const [current, setCurrent] = useState<Org>(org);
  const [name, setName] = useState(org.name);
  const [legalName, setLegalName] = useState(org.legal_name ?? '');
  const [description, setDescription] = useState(org.description ?? '');
  const [profileData, setProfileData] = useState<JsonRecord>(() => pick(org.profile, fields));
  const [extraErrors, setExtraErrors] = useState<ErrorSchema | undefined>(undefined);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const schemaForm = useRef<Form<JsonRecord>>(null);

  /** Takes a newer org (after a save, a move or a refresh) as the form's values. */
  function adopt(next: Org) {
    setCurrent(next);
    setName(next.name);
    setLegalName(next.legal_name ?? '');
    setDescription(next.description ?? '');
    // The API tidies values (e.g. a GSTIN is stored upper-cased).
    setProfileData(pick(next.profile, fields));
  }

  // A newer org from the page (after a move or a refresh) replaces the form's copy.
  const [seenUpdatedAt, setSeenUpdatedAt] = useState(org.updated_at);
  if (org.updated_at !== seenUpdatedAt) {
    setSeenUpdatedAt(org.updated_at);
    adopt(org);
  }

  /** The schema fields the owner changed: new value, or `null` to clear. */
  function profileChanges(): JsonRecord {
    const changes: JsonRecord = {};
    for (const field of view?.updatable ?? []) {
      const next = profileData[field];
      if (sameValue(next, current.profile[field])) continue;
      changes[field] = isEmpty(next) ? null : next;
    }
    return changes;
  }

  /** Whether a schema check fails on one of `changed` (top-level field names). */
  function blocksSave(changed: readonly string[]): boolean {
    const form = schemaForm.current;
    if (!form || changed.length === 0) return false;
    const { errors } = form.validate(profileData);
    // `property` is ".website" or ".domains.0"; the field is its first segment.
    return errors.some((err) => changed.includes((err.property ?? '').split(/[.[]/)[1] ?? ''));
  }

  async function onSubmit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    setExtraErrors(undefined);
    // The schema section checks itself (patterns, choices, GSTIN check character).
    // Only a changed field blocks the save: a value stored before a rule existed
    // must not stop the owner saving something else.
    if (editing && view && view.updatable.length > 0 && blocksSave(Object.keys(profileChanges()))) {
      schemaForm.current?.validateForm();
      setMessage(t('org.fix_fields'));
      return;
    }
    const patch: JsonRecord = {};
    if (editing) {
      if (name.trim() !== current.name) patch['name'] = name.trim();
      if (orNull(legalName) !== current.legal_name) patch['legal_name'] = orNull(legalName);
      if (orNull(description) !== current.description) patch['description'] = orNull(description);
      const changes = profileChanges();
      if (Object.keys(changes).length > 0) patch['profile'] = changes;
    }
    if (Object.keys(patch).length === 0) {
      setMessage(t('org.saved'));
      return;
    }
    setBusy(true);
    const r = await sendConsole<Org>(`/api/console/org/metadata/${org.id}`, 'PATCH', patch);
    setBusy(false);
    if (r.ok) {
      // The page's copy catches up through the refresh below.
      adopt(r.data);
      setMessage(t('org.saved'));
      router.refresh();
      return;
    }
    const serverErrors = r.error.fields?.['field_errors'];
    if (r.status === 400 && serverErrors && typeof serverErrors === 'object') {
      const mapped: JsonRecord = {};
      for (const [field, text] of Object.entries(serverErrors as JsonRecord)) {
        if (fields.includes(field)) mapped[field] = { __errors: [String(text)] };
      }
      if (Object.keys(mapped).length > 0) {
        setExtraErrors(mapped as ErrorSchema);
        setMessage(t('org.fix_fields'));
        return;
      }
    }
    setMessage(t(errorKey(r)));
  }

  const addresses = current.locations
    .map((l) =>
      [l.address?.streetAddress, l.address?.addressLocality, l.address?.addressRegion]
        .filter(Boolean)
        .join(', '),
    )
    .filter(Boolean);

  const status = (
    <div className="flex items-center gap-3">
      <Button type="submit" disabled={busy}>
        {t('org.save')}
      </Button>
      {message ? <output className="text-[13px] text-ink-600">{message}</output> : null}
    </div>
  );

  if (!editing) {
    // Read-only details (the Default org, the root, an org below the viewer's
    // own, or not the owner): plain text, not disabled inputs.
    const props = (view?.schema.properties ?? {}) as Record<string, JsonRecord>;
    const ui = view?.uiSchema ?? {};
    const schemaItems = fields.map((field) => ({
      label: String(props[field]?.['title'] ?? field),
      value:
        orgFieldText(props[field] ?? {}, (ui[field] ?? {}) as JsonRecord, current.profile[field]) ??
        '—',
    }));
    const items: Array<{ label: string; value: ReactNode }> = [
      { label: t('org.name'), value: current.name },
      ...(current.known_as === null || knownAsPicked
        ? []
        : [{ label: t('org.known_as'), value: knownAsText(current) }]),
      { label: t('org.legal_name'), value: current.legal_name ?? '—' },
      ...schemaItems,
      {
        label: t('org.description'),
        value: current.description ? (
          <span className="whitespace-pre-line">{current.description}</span>
        ) : (
          t('org.no_description')
        ),
      },
      {
        label: t('org.locations'),
        value: addresses.length ? addresses.join('; ') : t('org.no_locations'),
      },
    ];
    let note: string | null = null;
    if (current.is_default) note = t('org.read_only');
    else if (editable) note = t('org.details_owner_only');
    return (
      <ConsoleSection title={t('org.details')}>
        {note ? <p className="text-[13px] text-ink-500 mb-4">{note}</p> : null}
        <DetailList items={items} />
      </ConsoleSection>
    );
  }

  return (
    <ConsoleSection title={t('org.details')}>
      <form noValidate onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="org-name">{t('org.name')}</Label>
            <Input id="org-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          {knownAsPicked ? null : (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="org-known-as">{t('org.known_as')}</Label>
              <Input id="org-known-as" value={knownAsText(current)} disabled readOnly />
              <span className="text-[12px] text-ink-500">{t('org.known_as_parent_sets')}</span>
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="org-legal">{t('org.legal_name')}</Label>
            <Input
              id="org-legal"
              value={legalName}
              onChange={(e) => setLegalName(e.target.value)}
            />
          </div>
        </div>
        {view && fields.length > 0 ? (
          <RjsfThemedForm<JsonRecord>
            ref={schemaForm}
            tagName="div"
            schema={view.schema}
            uiSchema={
              {
                ...view.uiSchema,
                'ui:layout': 'grid',
                'ui:submitButtonOptions': { norender: true },
              } as unknown as UiSchema<JsonRecord>
            }
            formData={profileData}
            onChange={(ev) => {
              setProfileData((ev.formData ?? {}) as JsonRecord);
              setExtraErrors(undefined);
            }}
            transformErrors={(errors) => readableFormErrors(errors, view.schema)}
            {...(customValidate ? { customValidate } : {})}
            {...(extraErrors ? { extraErrors } : {})}
          />
        ) : null}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="org-description">{t('org.description')}</Label>
          <textarea
            id="org-description"
            className="bd-input min-h-[110px] resize-y"
            maxLength={DESCRIPTION_MAX}
            placeholder={t('org.description_placeholder')}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <div className="flex justify-between gap-3 text-[12px] text-ink-500">
            <span>{t('org.description_hint')}</span>
            <span aria-live="polite">
              {description.length}/{DESCRIPTION_MAX}
            </span>
          </div>
        </div>
        <div className="flex flex-col gap-1.5 text-[13.5px]">
          <span className="bd-label">{t('org.locations')}</span>
          {addresses.length ? (
            <ul className="flex flex-col gap-1">
              {addresses.map((a, i) => (
                <li key={`${a}-${i}`} className="flex items-start gap-2 text-ink-700">
                  <I.globe size={14} className="mt-0.5 shrink-0 text-ink-400" />
                  {a}
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-ink-500">{t('org.no_locations')}</span>
          )}
        </div>
        {status}
      </form>
    </ConsoleSection>
  );
}
