'use client';

import { useEffect, useMemo, useState, type JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { RJSFSchema, UiSchema } from '@rjsf/utils';
import { useTranslations } from 'next-intl';
import type { IChangeEvent } from '@rjsf/core';
import { RjsfThemedForm } from '../../../components/forms/RjsfThemed';
import type { ResolvedPlace } from '../../../components/forms/custom-widgets/LocationAutocompleteWidget';
import { ConsentGate } from '../../../components/consent/ConsentGate';
import { toConsentDocs } from '../../../components/consent/consent-docs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/Select';
import { useAggregatorConfig, DEFAULT_AGGREGATOR_CONFIG } from '../../../hooks/useAggregatorConfig';
import { withPhoneWidget } from '../../../lib/phone-ui-schema';
import { jsonFetch } from '../../../services/http';
import {
  stampConsent,
  stripConsentBlock,
  stripFormChrome,
  submitRegistration,
  withResolvedCoordinates,
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

export interface CoordinatorRegisterFormProps {
  /** Coordinator registration JSON Schema. */
  schema: RJSFSchema;
  /** Coordinator registration UI schema. */
  uiSchema: Record<string, unknown>;
  /**
   * Terms/Privacy content for the coordinator audience, shown by
   * {@link ConsentGate} at submit. Omit when loading failed; submit then shows an error.
   */
  consentContent?: ConsentDocContent;
  /**
   * Invite token. When set, the org is fixed to the inviting org, the email is
   * prefilled, and the submission sends `invite` instead of `org_id`. The
   * server validates everything; these props only shape the UI.
   */
  inviteToken?: string;
  /** The inviting org's display name (invite mode); fills the hidden `name`. */
  lockedOrgName?: string;
  /** The invite's email (invite mode); prefilled. */
  lockedEmail?: string;
}

/** One active-org option for the coordinator dropdown (`GET /api/orgs`). */
interface OrgOption {
  id: string;
  slug: string;
  display_name: string;
}

/** Slug of the fixed Default org. */
const DEFAULT_ORG_SLUG = 'default';

/**
 * Removes schema properties marked `"x-org-detail": true` (url, locations).
 *
 * These belong to the org, so a coordinator of a real org does not see or submit them.
 *
 * @param schema - The coordinator form schema.
 * @returns The schema without org-detail properties.
 */
function withoutOrgDetails(schema: RJSFSchema): RJSFSchema {
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const orgDetailKeys = Object.keys(props).filter((k) => props[k]?.['x-org-detail'] === true);
  if (orgDetailKeys.length === 0) return schema;
  return {
    ...schema,
    properties: Object.fromEntries(
      Object.entries(props).filter(([k]) => !orgDetailKeys.includes(k)),
    ) as RJSFSchema['properties'],
    ...(Array.isArray(schema.required)
      ? { required: schema.required.filter((k) => !orgDetailKeys.includes(k)) }
      : {}),
  };
}

/**
 * Renders the coordinator registration form with a required organisation selector.
 *
 * Picking a real org uses its name and hides the org-detail fields. Picking the
 * Default org shows the full form, where the coordinator enters their own
 * organisation name, url, and locations. The Default org is preselected when it
 * is the only one.
 *
 * @param props - Schema/UI schema, consent content and the invite context.
 * @returns The coordinator registration content block.
 */
export function CoordinatorRegisterForm({
  schema,
  uiSchema,
  consentContent,
  inviteToken,
  lockedOrgName,
  lockedEmail,
}: CoordinatorRegisterFormProps): JSX.Element {
  const t = useTranslations('register');
  const { data: cfg = DEFAULT_AGGREGATOR_CONFIG } = useAggregatorConfig();
  const brand = cfg.brand.short_name;
  // Invite mode: org is fixed by the invite, so no selector / no org list.
  const inviteMode = Boolean(inviteToken);

  const { state, setState, setCanSubmit, errorRef } = useRegistrationFormState();
  const [formData, setFormData] = useState<Record<string, unknown>>(() => ({
    // `[0,0]` means "not resolved yet" (`geo` is required). The real coordinate
    // is added at submit.
    locations: [{ geo: { type: 'Point', coordinates: [0, 0] }, address: {} }],
    // Prefill the invite email.
    ...(lockedEmail ? { contact: { email: lockedEmail } } : {}),
  }));
  // Selected org. Empty until picked.
  const [orgId, setOrgId] = useState<string>('');
  // Coordinate from the address widget; RJSF does not write it into `formData`.
  const [resolvedPlace, setResolvedPlace] = useState<ResolvedPlace | null>(null);
  const consentDocs = useMemo(() => toConsentDocs(consentContent), [consentContent]);
  const { gateOpen, setGateOpen, pendingRef, handleSubmit } = useConsentGateSubmit(
    consentDocs,
    setState,
  );

  // The active-org list (not needed in invite mode: the org is fixed).
  const orgsQuery = useQuery({
    queryKey: ['active-orgs'],
    queryFn: () => jsonFetch<{ orgs: OrgOption[] }>('/api/orgs'),
    enabled: !inviteMode,
    staleTime: 30_000,
  });
  const orgs = useMemo(() => orgsQuery.data?.orgs ?? [], [orgsQuery.data]);
  const selectedOrg = orgs.find((o) => o.id === orgId);
  // A real org supplies the name and details; Default org coordinators enter their own.
  const inheritsFromOrg =
    inviteMode || (selectedOrg !== undefined && selectedOrg.slug !== DEFAULT_ORG_SLUG);
  const selectedOrgName = inviteMode ? (lockedOrgName ?? '') : (selectedOrg?.display_name ?? '');

  // The API lists the Default org only when it is the only active org; preselect it then.
  useEffect(() => {
    if (inviteMode || orgId) return;
    const only = orgs.length === 1 ? orgs[0] : undefined;
    if (only?.slug === DEFAULT_ORG_SLUG) setOrgId(only.id);
  }, [inviteMode, orgId, orgs]);

  // Sync the hidden `name` with the org name; clear it on switching to the Default org.
  useEffect(() => {
    if (inheritsFromOrg) {
      const next = selectedOrgName || undefined;
      setFormData((prev) => (prev['name'] === next ? prev : { ...prev, name: next }));
    } else {
      setFormData((prev) =>
        orgs.some((o) => o.display_name === prev['name']) ? { ...prev, name: undefined } : prev,
      );
    }
  }, [inheritsFromOrg, selectedOrgName, orgs]);

  const formSchema = useMemo(() => {
    const base = stripConsentBlock(stripFormChrome(schema));
    return inheritsFromOrg ? withoutOrgDetails(base) : base;
  }, [schema, inheritsFromOrg]);

  const agreeLabel = `${t('consent.accept_prefix')}${t('consent.privacy_link')}${t('consent.and')}${t('consent.terms_link')}.`;

  // For a real org, hide the `name` field; the name comes from the org.
  const formUiSchema = useMemo<Record<string, unknown>>(() => {
    const withPhone = withPhoneWidget(uiSchema, formSchema as Record<string, unknown>);
    if (!inheritsFromOrg) return withPhone;
    // The invite email stays editable; the owner sees any mismatch at approval.
    return {
      ...withPhone,
      name: { ...((withPhone['name'] as Record<string, unknown>) ?? {}), 'ui:widget': 'hidden' },
    };
  }, [uiSchema, formSchema, inheritsFromOrg]);

  /** Opens the consent gate, or says that an organisation must be chosen first. */
  const submitWithOrg = (e: IChangeEvent<Record<string, unknown>>): void => {
    if (!inviteMode && !orgId) {
      setState({
        status: 'error',
        title: t('org_selector_required'),
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
    const payload: Record<string, unknown> = withResolvedCoordinates(
      {
        ...pendingRef.current,
        consent: stampConsent({ value: true }),
      },
      resolvedPlace,
    );
    // Invite mode sends `invite` (the org comes from the token); otherwise
    // `org_id` from the dropdown. For a real org, url and locations are not sent.
    if (inviteMode) {
      payload['invite'] = inviteToken;
    } else if (orgId) {
      payload['org_id'] = orgId;
    }
    if (inheritsFromOrg) {
      payload['name'] = selectedOrgName;
      delete payload['url'];
      delete payload['locations'];
    }
    const result = await submitRegistration('/api/aggregator/register', payload);
    setState(
      result.ok
        ? { status: 'done', refId: String(result.body['aggregator_id'] ?? '') }
        : { status: 'error', ...result.error },
    );
  };

  if (state.status === 'done') {
    return (
      <RegistrationSuccessPanel
        heading={t('success_heading')}
        refLabel={t('success_ref_id')}
        refId={state.refId}
        message={t('success_approval', { brand })}
      />
    );
  }

  return (
    <div className="mt-7">
      {showsErrorBanner(state) ? (
        <RegistrationErrorBanner title={state.title} detail={state.detail} errorRef={errorRef} />
      ) : null}

      {inviteMode ? (
        <output className="mb-5 block text-[13.5px] text-ink-500">
          Registering as a coordinator under{' '}
          <span className="font-semibold text-ink-800">{selectedOrgName}</span>.
        </output>
      ) : null}
      {!inviteMode ? (
        <div className="form-group mb-4">
          <label className="bd-label" htmlFor="coordinator-org">
            {t('org_selector_label')}
            <span className="text-rose-500"> *</span>
          </label>
          {orgsQuery.isError ? (
            <div className="text-[13px] text-red-600 flex items-center gap-2">
              {t('org_selector_error')}
              <button
                type="button"
                onClick={() => orgsQuery.refetch()}
                className="text-primary-600 font-semibold hover:underline"
              >
                {t('org_selector_retry')}
              </button>
            </div>
          ) : (
            <Select
              {...(orgId ? { value: orgId } : {})}
              onValueChange={setOrgId}
              disabled={orgsQuery.isLoading}
            >
              <SelectTrigger id="coordinator-org" aria-required>
                <SelectValue
                  placeholder={
                    orgsQuery.isLoading ? t('org_selector_loading') : t('org_selector_placeholder')
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {orgs.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.display_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      ) : null}

      <RjsfThemedForm
        schema={formSchema}
        uiSchema={formUiSchema as unknown as UiSchema<Record<string, unknown>>}
        {...sharedRegistrationFormProps({
          formData,
          setFormData,
          setCanSubmit,
          setState,
          handleSubmit: submitWithOrg,
          formSchema,
          consentContent,
          onLocationResolved: setResolvedPlace,
          validationErrorTitle: t('validation_error_title'),
          personName: {
            path: 'contact.name',
            message: (symbols) => t('name_symbols', { symbols }),
          },
        })}
      >
        <RegistrationSubmitButton
          submitting={state.status === 'submitting'}
          // Never disabled for an invalid field: a click shows what to fix.
          canSubmit
          label={t('submit')}
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
