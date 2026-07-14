'use client';

import { useMemo, useState } from 'react';
import type { RJSFSchema, UiSchema } from '@rjsf/utils';
import { useTranslations } from 'next-intl';
import { Topbar } from '../../../components/shell/Topbar';
import { Button } from '../../../components/ui/Button';
import { RjsfThemedForm } from '../../../components/forms/RjsfThemed';
import { useProfileRaw } from '../../../hooks/useProfile';
import { I } from '../../../icons';
import type { ProfileApiResponse } from '../../../services/profile.service';

/**
 * Read-only aggregator profile view (issue #470).
 *
 * Renders the *same* form the public registration page renders — the schema is
 * loaded server-side and passed in — populated with the signed-in aggregator's
 * stored profile, with every field disabled. The registration-only consent
 * block is hidden (a signup-time legal artifact, not editable profile data) and
 * the form's submit button is suppressed, so the fields can never be edited in
 * place. Changes are instead raised via the "Request an update" panel, which
 * lists each schema-flagged (`x-updatable`) field as a Field / Current / New
 * row. The admin-approval email flow behind it is not wired up yet, so
 * submitting only shows a "coming soon" acknowledgement.
 */

export interface ProfileFormViewProps {
  /** Registration JSON Schema (shared with `/register`). */
  schema: RJSFSchema;
  /** Registration RJSF UI schema (shared with `/register`). */
  uiSchema: Record<string, unknown>;
}

/**
 * Maps the merged profile API response into the registration schema's form
 * shape. Only the fields the registration schema declares are carried across;
 * post-login extras (personas, services) are intentionally omitted so the two
 * surfaces render identically.
 *
 * @param api - The merged `GET /v1/aggregators/profile/me` response.
 * @returns Form data keyed to the registration schema properties.
 */
function toFormData(api: ProfileApiResponse): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (api.org_name) data['name'] = api.org_name;
  if (api.type) data['type'] = api.type;
  if (api.url) data['url'] = api.url;
  if (api.contact) {
    data['contact'] = {
      name: api.contact.name,
      phone: api.contact.phone,
      email: api.contact.email,
    };
  }
  if (Array.isArray(api.locations) && api.locations.length > 0) {
    data['locations'] = api.locations;
  }
  return data;
}

/** A profile field the aggregator may request to change (schema `x-updatable`). */
interface UpdatableField {
  key: string;
  label: string;
}

/**
 * Reads the registration schema for top-level properties flagged
 * `x-updatable: true` and returns them (with their human labels) in declared
 * order. The editable set is therefore config-driven — flip the flag in
 * `registration.v1.json` to add or remove a field, no code change here.
 *
 * @param schema - The registration JSON Schema.
 * @returns The updatable fields, in property order.
 */
function collectUpdatableFields(schema: RJSFSchema): UpdatableField[] {
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  return Object.entries(props)
    .filter(([, def]) => def?.['x-updatable'] === true)
    .map(([key, def]) => ({ key, label: (def['title'] as string | undefined) ?? key }));
}

/**
 * Renders the aggregator's current value for an updatable field as one display
 * line. `locations` flattens to a single-line postal address; other fields
 * stringify their scalar value.
 *
 * @param key - Schema property key.
 * @param api - The merged profile response (may be undefined while loading).
 * @returns A display string (empty when unset).
 */
function currentValueFor(key: string, api: ProfileApiResponse | undefined): string {
  if (!api) return '';
  if (key === 'locations') {
    const addr = api.locations?.[0]?.address;
    if (!addr) return '';
    return [
      addr.streetAddress,
      addr.addressLocality,
      addr.addressRegion,
      addr.postalCode,
      addr.addressCountry,
    ]
      .filter((p): p is string => Boolean(p && p.length > 0))
      .join(', ');
  }
  const value = (api as unknown as Record<string, unknown>)[key];
  return value == null ? '' : String(value);
}

export function ProfileFormView({ schema, uiSchema }: ProfileFormViewProps): JSX.Element {
  const t = useTranslations('profile.view');
  const { data, isLoading, isError } = useProfileRaw();

  // Update-request panel (issue #470 part 3). The UI is present — one
  // Field/Current/New row per schema-flagged field plus a submit CTA — but the
  // admin-approval email flow is not wired up yet, so submitting only surfaces
  // a "coming soon" acknowledgement. No API call.
  const [requesting, setRequesting] = useState(false);
  const [newValues, setNewValues] = useState<Record<string, string>>({});
  const [requestSent, setRequestSent] = useState(false);

  const updatableFields = useMemo(() => collectUpdatableFields(schema), [schema]);
  const hasChanges = updatableFields.some((f) => (newValues[f.key] ?? '').trim() !== '');

  const closeRequest = (): void => {
    setRequesting(false);
    setNewValues({});
    setRequestSent(false);
  };

  // Reuse the registration UI schema, but hide the consent block and suppress
  // the submit button — the profile is display-only.
  const readonlyUiSchema = useMemo<Record<string, unknown>>(
    () => ({
      ...uiSchema,
      'ui:submitButtonOptions': { norender: true },
      consent: {
        ...((uiSchema['consent'] as Record<string, unknown> | undefined) ?? {}),
        'ui:widget': 'hidden',
      },
    }),
    [uiSchema],
  );

  // Strip the schema's title + API-contract description — the page owns its
  // heading (Topbar + read-only note), matching how /register renders.
  const displaySchema = useMemo<RJSFSchema>(() => {
    const clone = { ...schema } as RJSFSchema;
    delete (clone as { title?: string }).title;
    delete (clone as { description?: string }).description;
    return clone;
  }, [schema]);

  const formData = useMemo(() => (data ? toFormData(data) : {}), [data]);

  return (
    <div className="fade-up">
      <Topbar title={t('topbar_title')} subtitle={t('topbar_subtitle')} />

      <div className="bd-card bd-shadow overflow-hidden">
        {!requesting && (
          <div className="px-7 py-4 bg-gradient-to-r from-[var(--bd-tint-primary)] to-[var(--bd-card)] border-b border-[var(--bd-border)] flex items-center justify-between gap-4">
            <h2 className="font-display font-bold text-[15px] text-ink-900">
              {t('section_details')}
            </h2>
            <Button
              kind="ghost"
              icon={<I.edit size={14} />}
              onClick={() => setRequesting(true)}
              className="shrink-0"
            >
              {t('btn_request_update')}
            </Button>
          </div>
        )}

        {requesting && (
          <div className="px-7 pt-6">
            <div className="rounded-[12px] border border-[var(--bd-border)] bg-[var(--bd-tint-primary)] p-5">
              <h3 className="font-display font-bold text-[15px] text-ink-900">
                {t('update_request_heading')}
              </h3>
              <p className="text-[12.5px] text-ink-500 mt-1">{t('update_request_desc')}</p>

              {updatableFields.length === 0 ? (
                <p className="mt-4 text-[13px] text-ink-400">{t('update_request_empty')}</p>
              ) : (
                <div className="mt-4 space-y-3">
                  <div className="hidden md:grid grid-cols-[1fr_1.3fr_1.3fr] gap-3 px-1 text-[10.5px] uppercase tracking-[0.1em] font-semibold text-ink-400">
                    <span>{t('col_field')}</span>
                    <span>{t('col_current')}</span>
                    <span>{t('col_requested')}</span>
                  </div>
                  {updatableFields.map((f) => (
                    <div
                      key={f.key}
                      className="grid grid-cols-1 md:grid-cols-[1fr_1.3fr_1.3fr] gap-1.5 md:gap-3 md:items-center"
                    >
                      <div className="text-[13.5px] font-medium text-ink-900">{f.label}</div>
                      <div className="text-[13px] text-ink-500 break-words">
                        {currentValueFor(f.key, data) || <span className="text-ink-300">—</span>}
                      </div>
                      <input
                        className="bd-input"
                        value={newValues[f.key] ?? ''}
                        placeholder={t('new_value_placeholder')}
                        onChange={(e) => {
                          const { value } = e.target;
                          setNewValues((prev) => ({ ...prev, [f.key]: value }));
                          if (requestSent) setRequestSent(false);
                        }}
                      />
                    </div>
                  ))}
                </div>
              )}

              {requestSent && (
                <div className="mt-3 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800 flex items-start gap-2">
                  <I.alert size={14} className="mt-0.5 shrink-0" />
                  <span>{t('update_request_pending')}</span>
                </div>
              )}
              <div className="mt-4 flex items-center justify-end gap-2">
                <Button kind="ghost" onClick={closeRequest}>
                  {t('btn_cancel')}
                </Button>
                <Button
                  icon={<I.check size={14} />}
                  disabled={!hasChanges || requestSent}
                  onClick={() => setRequestSent(true)}
                >
                  {t('btn_submit_request')}
                </Button>
              </div>
            </div>
          </div>
        )}

        <div className="px-7 py-7">
          {isLoading ? (
            <div className="text-center text-ink-400 text-[13.5px] py-6">{t('loading')}</div>
          ) : isError ? (
            <div className="rounded-[10px] border border-rose-200 bg-rose-50 px-4 py-3">
              <div className="font-display font-bold text-[15px] text-rose-700">
                {t('error_load_title')}
              </div>
              <div className="text-[13px] text-rose-600 mt-1">{t('error_load_detail')}</div>
            </div>
          ) : (
            <RjsfThemedForm
              schema={displaySchema}
              uiSchema={readonlyUiSchema as unknown as UiSchema<Record<string, unknown>>}
              formData={formData}
              readonly
            >
              {/* Empty children suppress RJSF's default submit button. */}
              <></>
            </RjsfThemedForm>
          )}
        </div>
      </div>
    </div>
  );
}
