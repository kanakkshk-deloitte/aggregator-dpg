'use client';

import { useMemo, useState, type JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { IChangeEvent } from '@rjsf/core';
import type { RJSFSchema, UiSchema } from '@rjsf/utils';
import { useTranslations } from 'next-intl';
import { RjsfThemedForm } from '../../../components/forms/RjsfThemed';
import type { ResolvedPlace } from '../../../components/forms/custom-widgets/LocationAutocompleteWidget';
import { ConsentGate } from '../../../components/consent/ConsentGate';
import { toConsentDocs } from '../../../components/consent/consent-docs';
import { SearchableSelect, type SearchableOption } from '../../../components/ui/SearchableSelect';
import { jsonFetch } from '../../../services/http';
import {
  stampConsent,
  stripConsentBlock,
  stripFormChrome,
  submitRegistration,
  withOrgCoordinates,
  type SubmitError,
} from './registration-shared';
import {
  RegistrationErrorBanner,
  showsErrorBanner,
  RegistrationSubmitButton,
  RegistrationSuccessPanel,
  sharedRegistrationFormProps,
  useConsentGateSubmit,
  useRegistrationFormState,
} from './registration-ui';
import type { ConsentDocContent } from '../../../components/consent/consent-types';
import { gstinCustomValidate } from '../../../lib/org-schema';
import { withPhoneWidget } from '../../../lib/phone-ui-schema';
import { readableFormErrors } from '../../../lib/readable-form-errors';

/** One org a new org can register under (`GET /api/orgs/parents`). */
interface ParentOption {
  id: string;
  name: string;
  /** True for the network root (a top-level org). */
  is_root: boolean;
  known_as_name: string | null;
  /** What an organisation registered under this one is known as. */
  child_known_as_name: string | null;
}

/** `GET /api/orgs/parents`: whether registration is open, and the parents that can take a child now. */
interface ParentsResponse {
  accepting: boolean;
  parents: ParentOption[];
}

/** Message keys for the API's tree refusals on `/v1/orgs/create`. */
const TREE_ERRORS: Record<string, string> = {
  ORG_DEPTH_LIMIT: 'org_error_depth_limit',
  ORG_CHILD_LIMIT: 'org_error_child_limit',
  ORG_TOTAL_LIMIT: 'org_error_total_limit',
  CONFLICT: 'org_error_conflict',
};

/**
 * Returns the message key for a tree refusal, or null for any other error.
 *
 * @param error - The failed submission.
 * @returns A key under `register`, or null.
 */
function treeErrorKey(error: SubmitError): string | null {
  if (error.code === 'SCHEMA_VALIDATION') {
    return error.fields?.['parent_id'] === 'invalid' ? 'org_error_parent' : null;
  }
  return TREE_ERRORS[error.code] ?? null;
}

export interface OrgRegisterFormProps {
  /** Org-registration JSON Schema loaded by the server component. */
  schema: RJSFSchema;
  /** RJSF UI schema for the org form. */
  uiSchema: Record<string, unknown>;
  /**
   * Terms/Privacy content for the org audience, shown by {@link ConsentGate}
   * at submit. Omit when loading failed; submit then shows an error.
   */
  consentContent?: ConsentDocContent;
}

/**
 * Renders the organisation registration form.
 *
 * Submits through the BFF to `/v1/orgs/create`. The parent picker shows only
 * when an org other than the network root can take a child; otherwise the org
 * is registered under the root and no `parent_id` is sent. When registration
 * is closed the form is replaced by a notice. A new org stays `pending` until
 * a network admin approves it.
 *
 * @param props - The org JSON Schema + UI schema.
 * @returns The org registration content block (form, success, or error state).
 */
export function OrgRegisterForm({
  schema,
  uiSchema,
  consentContent,
}: OrgRegisterFormProps): JSX.Element {
  const t = useTranslations('register');
  const { state, setState, setCanSubmit, errorRef } = useRegistrationFormState();
  const [formData, setFormData] = useState<Record<string, unknown>>({});
  // Coordinate from the address widget; RJSF does not write it into `formData`.
  const [resolvedPlace, setResolvedPlace] = useState<ResolvedPlace | null>(null);
  // Selected parent org. Required when the picker shows; empty until picked.
  const [parentId, setParentId] = useState<string>('');
  const parentsQuery = useQuery({
    queryKey: ['org-parents'],
    queryFn: () => jsonFetch<ParentsResponse>('/api/orgs/parents'),
    staleTime: 30_000,
  });
  const parents = parentsQuery.data?.parents ?? [];
  // The picker shows when an org other than the root can take a child.
  const showPicker = parents.some((p) => !p.is_root);
  const chosen = showPicker ? parents.find((p) => p.id === parentId) : parents[0];
  const childName = chosen?.child_known_as_name ?? null;
  const parentReady = parentsQuery.data !== undefined && (!showPicker || parentId !== '');
  // The network first, then each org with its own "known as" value on the right.
  const parentOptions: SearchableOption[] = parents.map((p: ParentOption) => ({
    value: p.id,
    label: p.name,
    hint: p.is_root ? t('parent_top_level') : p.known_as_name,
  }));
  const consentDocs = useMemo(() => toConsentDocs(consentContent), [consentContent]);
  const { gateOpen, setGateOpen, pendingRef, handleSubmit } = useConsentGateSubmit(
    consentDocs,
    setState,
  );

  const formSchema = useMemo(() => stripConsentBlock(stripFormChrome(schema)), [schema]);
  const formUiSchema = useMemo(
    () => withPhoneWidget(uiSchema, formSchema as Record<string, unknown>),
    [uiSchema, formSchema],
  );
  const customValidate = useMemo(() => gstinCustomValidate(formSchema), [formSchema]);

  const agreeLabel = `${t('consent.accept_prefix')}${t('consent.privacy_link')}${t('consent.and')}${t('consent.terms_link')}.`;

  /** Opens the consent gate, or reports the missing parent (Enter submits past a disabled button). */
  const submitWithParent = (e: IChangeEvent<Record<string, unknown>>): void => {
    if (!parentReady) {
      setState({
        status: 'error',
        title: t('parent_selector_required'),
        detail: '',
        code: 'CLIENT_VALIDATION',
        requestId: '',
      });
      return;
    }
    handleSubmit(e);
  };

  /** Runs after the gate is accepted: stamps consent and posts. */
  const submitWithConsent = async (): Promise<void> => {
    setGateOpen(false);
    setState({ status: 'submitting' });
    const body: Record<string, unknown> = {
      ...pendingRef.current,
      consent: stampConsent({ value: true }),
      ...(showPicker ? { parent_id: parentId } : {}),
    };
    const payload = withOrgCoordinates(body, resolvedPlace);
    const result = await submitRegistration('/api/org/register', payload);
    if (!result.ok) {
      const key = treeErrorKey(result.error);
      setState(
        key
          ? { status: 'error', ...result.error, title: t(key), detail: '' }
          : { status: 'error', ...result.error },
      );
      return;
    }
    // 201: new pending registration. 200 with status 'active': the org already
    // exists and its owner was mailed the invite link.
    const alreadyRegistered = result.body['status'] === 'active';
    setState({
      status: 'done',
      refId: String(result.body['slug'] ?? ''),
      outcome: alreadyRegistered ? 'already_registered' : 'pending',
      mailSent: result.body['mail_sent'] !== false,
    });
  };

  if (state.status === 'done') {
    const already = state.outcome === 'already_registered';
    const message = already
      ? state.mailSent === false
        ? t('org_exists_mail_failed')
        : t('org_exists_link_sent')
      : t('org_success_review');
    return (
      <RegistrationSuccessPanel
        heading={already ? t('org_exists_heading') : t('org_success_heading')}
        refLabel={t('org_success_slug')}
        refId={state.refId}
        message={message}
      />
    );
  }

  if (parentsQuery.data?.accepting === false) {
    return (
      <div className="mt-7 rounded-xl border border-ink-100 bg-ink-50 px-4 py-3" role="status">
        <div className="font-semibold text-ink-900">{t('closed_title')}</div>
        <p className="mt-1 text-[13px] text-ink-600">{t('closed_detail')}</p>
      </div>
    );
  }

  return (
    <div className="mt-7">
      {showsErrorBanner(state) ? (
        <RegistrationErrorBanner title={state.title} detail={state.detail} errorRef={errorRef} />
      ) : null}

      {parentsQuery.isError ? (
        <div className="form-group mb-4 text-[13px] text-red-600 flex items-center gap-2">
          {t('parent_selector_error')}
          <button
            type="button"
            onClick={() => parentsQuery.refetch()}
            className="text-primary-600 font-semibold hover:underline"
          >
            {t('org_selector_retry')}
          </button>
        </div>
      ) : null}
      {showPicker ? (
        <div className="form-group mb-4">
          <label className="bd-label" htmlFor="org-parent">
            {t('parent_selector_label')}
            <span className="text-rose-500"> *</span>
          </label>
          <SearchableSelect
            id="org-parent"
            options={parentOptions}
            value={parentId}
            onValueChange={setParentId}
            placeholder={t('parent_selector_placeholder')}
            searchPlaceholder={t('parent_search_placeholder')}
            emptyText={t('parent_no_match')}
          />
        </div>
      ) : null}
      {childName ? (
        <p className="form-group mb-4 text-[12.5px] text-ink-500">
          {t('parent_child_hint', { name: childName })}
        </p>
      ) : null}

      <RjsfThemedForm
        schema={formSchema}
        uiSchema={formUiSchema as unknown as UiSchema<Record<string, unknown>>}
        {...sharedRegistrationFormProps({
          formData,
          setFormData,
          setCanSubmit,
          setState,
          handleSubmit: submitWithParent,
          formSchema,
          consentContent,
          onLocationResolved: setResolvedPlace,
          validationErrorTitle: t('validation_error_title'),
          personName: {
            path: 'owner.name',
            message: (symbols) => t('name_symbols', { symbols }),
          },
          customValidate,
        })}
        transformErrors={(errors) => readableFormErrors(errors, formSchema)}
      >
        {/* Never disabled by a bad field: a click runs the form's checks and
            shows each field's message, so the owner sees what to fix. */}
        <RegistrationSubmitButton
          submitting={state.status === 'submitting'}
          // Never disabled for an invalid field: a click shows what to fix.
          canSubmit={parentsQuery.data !== undefined}
          label={t('org_submit')}
          submittingLabel={t('submitting')}
        />
      </RjsfThemedForm>

      <ConsentGate
        open={gateOpen}
        docs={consentDocs}
        agreeLabel={agreeLabel}
        onAccept={submitWithConsent}
        onCancel={() => setGateOpen(false)}
      />
    </div>
  );
}
