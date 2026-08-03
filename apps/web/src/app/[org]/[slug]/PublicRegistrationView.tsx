'use client';

import Image from 'next/image';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { RJSFSchema, UiSchema } from '@rjsf/utils';
import type { IChangeEvent } from '@rjsf/core';
import { useTranslations } from 'next-intl';
import { RjsfThemedForm } from '../../../components/forms/RjsfThemed';
import { BlueDotsLogo } from '../../../components/ui/BlueDotsLogo';
import { I } from '../../../icons';
import { useAggregatorConfig, DEFAULT_AGGREGATOR_CONFIG } from '../../../hooks/useAggregatorConfig';
import { MinimalIdentityForm, type MinimalIdentityPayload } from './MinimalIdentityForm';
import { LanguageSwitcher } from '../../../components/shell/LanguageSwitcher';
import { ConsentModal, type ConsentTab } from '../../../components/consent/ConsentModal';
import type { ParticipantConsent } from '../../../components/consent/consent-types';

export interface PublicRegistrationViewProps {
  org: string;
  slug: string;
  /**
   * Active signalstack network id (e.g. 'blue_dot'). Required for the
   * pre-submit identity probe (`/api/[org]/[slug]/lookup`). Empty string
   * disables the probe — older API builds may not return this field.
   */
  network?: string;
  domain: string;
  context: Record<string, unknown>;
  schema: RJSFSchema;
  uiSchema: Record<string, unknown>;
  /**
   * Identity field selectors for the domain (name / phone / email). For the
   * account_only form, these are the only fields collected — signalstack
   * creates a user row with no item. Absent on older API builds.
   */
  identity?: { name?: string; phone?: string; email?: string } | undefined;
  /**
   * Resolved per-link submission shape. `account_only` locks the form to
   * identity fields only and skips the RJSF profile schema entirely;
   * `account_and_profile` renders the full profile form.
   */
  submissionShape: 'account_only' | 'account_and_profile';
  /**
   * Optional i18n key for a hint rendered beneath the public form (e.g. the
   * voice-call notice for an account_only link). `null` = no hint.
   */
  publicHintI18nKey: string | null;
  /**
   * Per-link registration mode key (e.g. `voice`, `form`). Voice links make
   * the phone number mandatory and drop the email field on the minimal form.
   */
  registrationMode?: string | null;
  /**
   * Participant consent copy for the modals (§4.1): Terms/Privacy documents +
   * the distinct profile-creation statement. `null` when unavailable — the
   * consent checkboxes then render plain labels with no modal links.
   */
  consentContent?: ParticipantConsent | null;
}

type SubmitState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'done'; submissionId: string; outcome: 'passed' | 'skipped' }
  | { status: 'error'; title: string; detail: string; code: string };

/**
 * Outcome of the pre-submit identity probe — drives the branched UI
 * (allow normal submit / show owned-elsewhere / offer resume).
 */
type LookupOutcome =
  | { kind: 'allow' }
  | { kind: 'owned_elsewhere' }
  // Already fully registered with THIS aggregator (live item). Re-submitting
  // would fail upstream with a cryptic INVALID_ITEM_STATE — short-circuit with
  // a clear message instead.
  | { kind: 'already_registered' }
  | {
      kind: 'resume';
      itemId: string;
      lifecycleStatus: 'draft' | 'live' | 'paused';
    };

interface LookupResponse {
  user_exists?: boolean;
  owned_elsewhere?: boolean;
  lifecycle_summary?: {
    primary_item?: {
      item_id: string;
      lifecycle_status: 'draft' | 'live' | 'paused';
    } | null;
  } | null;
}

interface SubmitResponse {
  outcome: 'passed' | 'skipped';
  submission_id: string;
  /**
   * Server omits this on the public path to avoid leaking the DB row UUID
   * of an existing participant. Kept optional so older builds that did
   * include it still type-check.
   */
  participant_id?: string | null;
  message?: string;
}

interface ApiErrorEnvelope {
  error?: { code?: string; title?: string; detail?: string };
}

/**
 * Renders the anonymous participant-registration form. Slug + domain come
 * from the server resolve; the form schema drives the UI. Submit POSTs to
 * the BFF, which proxies to `/public/v1/registrations/create/:slug`.
 */
export function PublicRegistrationView({
  org,
  slug,
  network = '',
  domain,
  context,
  schema,
  uiSchema,
  identity,
  submissionShape,
  publicHintI18nKey,
  registrationMode,
  consentContent = null,
}: PublicRegistrationViewProps): JSX.Element {
  const t = useTranslations('profile.public_reg');
  // Terms/Privacy modal for the participant consent copy (§4.1).
  const [consentModal, setConsentModal] = useState<{ open: boolean; tab: ConsentTab }>({
    open: false,
    tab: 'terms',
  });
  // Profile-creation consent has its OWN statement (a separate consent point),
  // shown in its own lightweight modal — not the Terms/Privacy one.
  const [profileConsentModal, setProfileConsentModal] = useState(false);
  const [formData, setFormData] = useState<Record<string, unknown>>({});
  const [state, setState] = useState<SubmitState>({ status: 'idle' });
  /**
   * Pre-submit probe outcome. `null` = probe hasn't run yet (or returned
   * "allow"); `owned_elsewhere` / `resume` short-circuit the submit
   * pipeline and render branched UI instead.
   */
  const [lookup, setLookup] = useState<LookupOutcome | null>(null);
  /**
   * Forces the next submit to bypass the probe — set when the user picks
   * "Continue with a new submission" from the resume prompt. One-shot:
   * cleared the moment the submit fires.
   */
  const [bypassProbe, setBypassProbe] = useState(false);
  // Defer required-field error rendering until the user has actually
  // interacted (typed in a field) or attempted submit once. Otherwise
  // RJSF's `liveValidate` paints every required field red on first
  // mount — unfriendly UX for a public-form first impression.
  const [showValidation, setShowValidation] = useState(false);
  // Schema-validity of the visible form, driven by RjsfThemedForm. Gates the
  // submit button — disabled until every visible required field is valid.
  const [canSubmit, setCanSubmit] = useState(false);
  // Single consent acceptance covering terms + privacy + profile-creation
  // (§3.1's three points). Gates the submit button and is sent as
  // consent_terms / consent_privacy / consent_profile (all true on accept),
  // validated server-side (CONSENT_REQUIRED).
  const [consentAccepted, setConsentAccepted] = useState(false);
  // Year of birth → derived age (§4.4 snapshot: no birthdate stored). Drives
  // the U18 branch and the compliance `age`, independent of the profile's own
  // `age` schema field. A minor still submits, but without consent — the API
  // omits age + compliance so Signals creates the account, and terms are
  // accepted later in the Signalstack app. Fail-closed at the boundary: <= 18.
  const [yearOfBirth, setYearOfBirth] = useState('');
  const currentYear = new Date().getFullYear();
  const yobNum = Number(yearOfBirth.trim());
  const yobValid =
    /^\d{4}$/.test(yearOfBirth.trim()) && yobNum >= currentYear - 120 && yobNum <= currentYear;
  const derivedAge = yobValid ? currentYear - yobNum : NaN;
  const isMinor = yobValid && derivedAge <= 18;
  const { data: cfg = DEFAULT_AGGREGATOR_CONFIG } = useAggregatorConfig();
  const brandShort = cfg.brand.short_name;
  const brandLogo = cfg.brand.logo?.default;
  const errorRef = useRef<HTMLDivElement>(null);

  // Submit button sits below a long form; on failure pull the error
  // banner into view + focus so the user sees why nothing happened.
  useEffect(() => {
    if (state.status === 'error' && errorRef.current) {
      errorRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
      errorRef.current.focus();
    }
  }, [state]);

  // Hide schema's verbose title/description from the form — the page header
  // owns the framing copy. Also drop `participant_id` from the public form:
  // it's a bulk-upload-only field (aggregator-supplied stable ID for dedup).
  // The submit endpoint server-side mints one when missing.
  const formSchema = useMemo<RJSFSchema>(() => {
    // Deep clone: the transforms below (ref inlining, partial-mode constraint
    // stripping) mutate nested property objects. A shallow spread would leave
    // those nested objects shared with the `schema` prop and leak mutations
    // back into it across renders (e.g. partial-mode deletes surviving a
    // toggle back to full mode).
    const clone: RJSFSchema = structuredClone(schema);
    delete (clone as { title?: string }).title;
    delete (clone as { description?: string }).description;
    const props = (clone as { properties?: Record<string, unknown> }).properties;
    if (props && 'participant_id' in props) {
      const { participant_id: _omit, ...rest } = props as Record<string, unknown>;
      (clone as { properties?: Record<string, unknown> }).properties = rest;
    }
    // Form mode silently accepts partial submissions: only the identity
    // fields signals needs (name + at least one contact) stay required, so a
    // participant can save a partial profile and finish later. signals'
    // classifier marks the resulting item `draft` when profile fields are
    // missing. Everything else (including `participant_id`) drops out of
    // `required`. The server re-applies the same leniency (drops Ajv
    // `required` errors), so this only governs the client RJSF gate.
    const identityKeys = new Set(
      [identity?.name, identity?.phone, identity?.email].filter(
        (k): k is string => typeof k === 'string' && k.length > 0,
      ),
    );
    const required = (clone as { required?: string[] }).required;
    if (Array.isArray(required)) {
      (clone as { required?: string[] }).required = required.filter((r) => identityKeys.has(r));
    }
    // Inline `items.$ref → #/$defs/<x>` enum hits so RJSF's checkboxes
    // widget receives a populated `enumOptions` list. RJSF's runtime
    // ref-resolver only follows refs through ajv during validation, not
    // when computing widget options — without inlining the array fields
    // render as empty boxes.
    const defs = (clone as { $defs?: Record<string, Record<string, unknown>> }).$defs ?? {};
    const inlined = (clone as { properties?: Record<string, Record<string, unknown>> }).properties;
    if (inlined) {
      for (const [field, def] of Object.entries(inlined)) {
        if (def?.['type'] !== 'array') continue;
        const items = def['items'] as Record<string, unknown> | undefined;
        const ref = typeof items?.['$ref'] === 'string' ? (items['$ref'] as string) : null;
        if (ref?.startsWith('#/$defs/')) {
          const target = defs[ref.slice('#/$defs/'.length)];
          if (target) {
            // Drop the ref and copy the resolved enum/type onto items
            // in place — RJSF reads from this shape directly.
            const { $ref: _r, ...keep } = items as Record<string, unknown>;
            (inlined[field] as Record<string, unknown>).items = { ...target, ...keep };
          }
        }
        // RJSF only computes a populated `enumOptions` list on the
        // array widget when `uniqueItems: true` is set. The purple_dot
        // schemas omit it, so multi-select dropdowns render with zero
        // options without this nudge.
        const resolvedItems = (inlined[field] as Record<string, unknown>).items as
          | Record<string, unknown>
          | undefined;
        if (resolvedItems && Array.isArray(resolvedItems['enum'])) {
          (inlined[field] as Record<string, unknown>).uniqueItems = true;
        }
      }
      // Partial-accept: dropping a field from `required` is not enough — RJSF
      // seeds array fields with `[]` (trips `minItems`) and the form starts
      // with empty strings (trips `minLength`). Strip the minimum-presence
      // constraints from every non-identity field so a bare identity submit
      // validates client-side. enum / format / type stay — those only fire on
      // a value the participant actually entered.
      for (const [field, def] of Object.entries(inlined)) {
        if (identityKeys.has(field) || !def || typeof def !== 'object') continue;
        delete (def as Record<string, unknown>)['minItems'];
        delete (def as Record<string, unknown>)['minLength'];
        delete (def as Record<string, unknown>)['minimum'];
      }
    }
    return clone;
  }, [schema, identity]);

  // Default uiSchema cleanups: array fields become a single comma-separated
  // tag input (no "Add another entry" row-builder), boolean / required-string
  // fields span full width so the 2-col grid doesn't strand orphans.
  // Caller-supplied uiSchema entries override these defaults via spread.
  const mergedUiSchema = useMemo<Record<string, unknown>>(() => {
    const props = (schema as { properties?: Record<string, Record<string, unknown>> }).properties;
    const defs = (schema as { $defs?: Record<string, Record<string, unknown>> }).$defs ?? {};
    const resolveItemEnum = (itemsDef: Record<string, unknown> | undefined): string[] | null => {
      if (!itemsDef) return null;
      // Direct enum on items.
      if (Array.isArray(itemsDef['enum'])) return itemsDef['enum'] as string[];
      // $ref into $defs (purple_dot schemas pull enums through $defs).
      const ref = itemsDef['$ref'];
      if (typeof ref === 'string' && ref.startsWith('#/$defs/')) {
        const key = ref.slice('#/$defs/'.length);
        const target = defs[key];
        if (target && Array.isArray(target['enum'])) return target['enum'] as string[];
      }
      return null;
    };
    const required = new Set(
      ((schema as { required?: string[] }).required ?? []).filter((r) => r !== 'participant_id'),
    );
    const defaults: Record<string, unknown> = {};
    const order: string[] = [];
    const tail: string[] = [];
    if (props) {
      for (const [field, def] of Object.entries(props)) {
        if (field === 'participant_id') continue;
        const type = def?.['type'];
        const isRequired = required.has(field);
        if (type === 'array') {
          const items = def?.['items'] as Record<string, unknown> | undefined;
          const itemEnum = resolveItemEnum(items);
          if (itemEnum && itemEnum.length > 0) {
            // Array of enum values — render as a multi-select checkbox
            // group so users can only pick allowed values. Bypasses the
            // free-text CommaSeparatedArrayWidget which lets the user
            // type anything and trips Ajv's enum check at submit.
            defaults[field] = {
              'ui:widget': 'checkboxes',
              'ui:colSpan': 2,
              items: { 'ui:label': false },
            };
          } else {
            defaults[field] = {
              'ui:widget': 'CommaSeparatedArrayWidget',
              'ui:colSpan': 2,
              'ui:options': { itemLabel: 'entry' },
              items: { 'ui:label': false },
            };
          }
          // Long-form fields land last so the short pairs sit tidy on top.
          tail.push(field);
        } else if (type === 'boolean') {
          defaults[field] = { 'ui:colSpan': 2 };
          tail.push(field);
        } else if (isRequired) {
          order.push(field);
        } else {
          tail.push(field);
        }
      }
    }
    return {
      'ui:order': [...order, ...tail, '*'],
      ...defaults,
      ...uiSchema,
      participant_id: { 'ui:widget': 'hidden' },
    };
  }, [schema, uiSchema]);

  const eventLabel =
    (typeof context['title'] === 'string' && (context['title'] as string)) ||
    (typeof context['lever_event'] === 'string' && (context['lever_event'] as string)) ||
    'Register';
  const orgName = typeof context['org_name'] === 'string' ? (context['org_name'] as string) : '';
  const locationLabel = [context['district'], context['state'], context['event_location']]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .join(' · ');

  /**
   * Runs the identity probe before the actual submit. Picks `email` or
   * `phone` off the RJSF form data and asks the BFF whether this contact
   * already lives in signalstack — either with another aggregator
   * (`owned_elsewhere`) or as an unfinished profile under us (`resume`).
   *
   * Returns `{ kind: 'allow' }` when no identity is supplied, when the
   * network id is unknown, when the BFF errors, or when the probe says
   * the contact is new — i.e. the caller should proceed with submit.
   *
   * @param values - Current RJSF formData.
   * @returns Branching outcome consumed by `handleSubmit`.
   */
  const runIdentityProbe = async (values: Record<string, unknown>): Promise<LookupOutcome> => {
    if (!network) return { kind: 'allow' };
    // Read identity off the form using the network's field selectors
    // (e.g. purple_dot's `mobile_number`, orange_dot's own keys), not a
    // hardcoded `phone`/`email`. Without this the probe silently misses the
    // contact on non-standard-field networks and owned_elsewhere no-ops.
    // Fall back to the common keys when the config omits a selector.
    const emailKey = identity?.email;
    const phoneKey = identity?.phone;
    const emailRaw = emailKey ? values[emailKey] : values['email'];
    const phoneRaw = phoneKey
      ? values[phoneKey]
      : (values['phone'] ?? values['phone_number'] ?? values['mobile']);
    const email = typeof emailRaw === 'string' && emailRaw.trim().length > 0 ? emailRaw.trim() : '';
    const phone = typeof phoneRaw === 'string' && phoneRaw.trim().length > 0 ? phoneRaw.trim() : '';
    if (!email && !phone) return { kind: 'allow' };
    const qs = new URLSearchParams();
    if (email) qs.set('email', email);
    if (phone) qs.set('phone_number', phone);
    qs.set('network', network);
    qs.set('domain', domain);
    let res: Response;
    try {
      res = await fetch(
        `/api/${encodeURIComponent(org)}/${encodeURIComponent(slug)}/lookup?${qs.toString()}`,
        { method: 'GET', headers: { accept: 'application/json' } },
      );
    } catch {
      // Network blip — fall through to a normal submit; the API will
      // either accept the row or surface a dedup 409 itself.
      return { kind: 'allow' };
    }
    if (!res.ok) return { kind: 'allow' };
    const body = (await res.json().catch(() => ({}))) as LookupResponse;
    if (body.owned_elsewhere) return { kind: 'owned_elsewhere' };
    const primary = body.lifecycle_summary?.primary_item;
    // Already registered with THIS aggregator and the profile is live → nothing
    // to add. Surface a clear "already registered" message rather than letting
    // the submit hit signalstack and fail with INVALID_ITEM_STATE.
    if (primary && primary.lifecycle_status === 'live') {
      return { kind: 'already_registered' };
    }
    if (
      primary &&
      (primary.lifecycle_status === 'draft' || primary.lifecycle_status === 'paused')
    ) {
      return {
        kind: 'resume',
        itemId: primary.item_id,
        lifecycleStatus: primary.lifecycle_status,
      };
    }
    return { kind: 'allow' };
  };

  /**
   * Identity-only submit for `submission_shape === 'account_only'` links.
   * Delegates to {@link handleSubmit} with a synthesised RJSF event so the
   * probe + POST + state handling stays in one place. The server enforces
   * the capture-scope; this form simply does not collect profile fields.
   */
  const handleMinimalSubmit = async (payload: MinimalIdentityPayload): Promise<void> => {
    await handleSubmit(
      { formData: payload as unknown as Record<string, unknown> } as IChangeEvent<
        Record<string, unknown>
      >,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      undefined as any,
    );
  };

  const handleSubmit = async (
    e: IChangeEvent<Record<string, unknown>>,
    _event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    const values = (e.formData ?? {}) as Record<string, unknown>;
    // Pre-submit probe. Skipped when the user has explicitly chosen
    // "Continue with a new submission" after a resume prompt.
    if (!bypassProbe) {
      setState({ status: 'submitting' });
      const outcome = await runIdentityProbe(values);
      if (outcome.kind !== 'allow') {
        setLookup(outcome);
        setState({ status: 'idle' });
        return;
      }
    } else {
      setBypassProbe(false);
    }
    setLookup(null);
    setState({ status: 'submitting' });
    try {
      const res = await fetch(
        `/api/${encodeURIComponent(org)}/${encodeURIComponent(slug)}/submit`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Full profile submit. The server resolves the link's
          // registration_mode shape and silently accepts partial profiles
          // (missing required fields → signals classifies the item `draft`).
          // consent_terms/consent_privacy carry the registrant's accepted
          // consent (#522); the API validates + records it, then strips the
          // keys before the participant profile is built.
          body: JSON.stringify({
            ...values,
            consent_terms: consentAccepted,
            consent_privacy: consentAccepted,
            consent_profile: consentAccepted,
            year_of_birth: yearOfBirth.trim(),
          }),
        },
      );
      // 409 with outcome=skipped is a dedup hit, not a failure: this
      // person is already registered with this aggregator. Render the
      // friendly "already registered" done screen instead of a red
      // error banner.
      if (res.status === 409) {
        const dup = (await res.json().catch(() => ({}))) as {
          outcome?: string;
          submission_id?: string;
        };
        if (dup.outcome === 'skipped') {
          setState({
            status: 'done',
            submissionId: dup.submission_id ?? '',
            outcome: 'skipped',
          });
          return;
        }
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as ApiErrorEnvelope;
        setState({
          status: 'error',
          title: body.error?.title ?? t('error_submission_title'),
          detail: body.error?.detail ?? t('error_server_detail', { status: res.status }),
          code: body.error?.code ?? 'UNKNOWN',
        });
        return;
      }
      const body = (await res.json()) as SubmitResponse;
      setState({
        status: 'done',
        submissionId: body.submission_id,
        outcome: body.outcome,
      });
    } catch (err) {
      setState({
        status: 'error',
        title: t('error_network_title'),
        detail: err instanceof Error ? err.message : t('error_network_detail'),
        code: 'NETWORK_ERROR',
      });
    }
  };

  // Hero fill — flat solid primary. No gradient shades.
  const heroGradient = cfg.brand.primary_color ?? '#4338ca';

  // `account_only` shape locks the form to identity fields only — render
  // MinimalIdentityForm and skip the RJSF profile tree entirely. Owned-
  // elsewhere / resume / done / error states stay shared with the full form
  // path; only the data-entry surface differs. The full handleSubmit
  // pipeline runs underneath via handleMinimalSubmit so probe + dedup + 409
  // handling behave identically.
  const isAccountOnly = submissionShape === 'account_only';

  if (isAccountOnly && state.status === 'idle' && !lookup) {
    return (
      <div
        className="bd-public-light min-h-screen w-full"
        style={{
          background:
            'radial-gradient(1200px 600px at 50% -10%, var(--bd-tint-primary), transparent 70%), #FBFCFE',
        }}
      >
        <div className="max-w-[640px] mx-auto px-4 sm:px-6 lg:px-10 py-8 sm:py-12">
          <div className="flex justify-end mb-3">
            <LanguageSwitcher />
          </div>
          {/* This branch only renders while state is 'idle', so the parent
              has no in-flight signal to pass — the form's own internal submit
              guard prevents the double-tap during the async probe. */}
          <MinimalIdentityForm
            identity={identity ?? {}}
            onSubmit={handleMinimalSubmit}
            brandColor={heroGradient}
            hintI18nKey={publicHintI18nKey}
            requirePhone={registrationMode === 'voice'}
            consentContent={consentContent}
          />
        </div>
        {consentContent && (
          <ConsentModal
            open={consentModal.open}
            onOpenChange={(open) => setConsentModal((s) => ({ ...s, open }))}
            initialTab={consentModal.tab}
            content={consentContent}
          />
        )}
      </div>
    );
  }

  return (
    <div
      className="bd-public-light min-h-screen w-full"
      style={{
        background:
          'radial-gradient(1200px 600px at 50% -10%, var(--bd-tint-primary), transparent 70%), #FBFCFE',
      }}
    >
      <div className="max-w-[760px] mx-auto px-4 sm:px-6 lg:px-10 py-8 sm:py-12">
        <header className="flex items-center justify-between gap-4 mb-6">
          {brandLogo ? (
            <Image
              src={brandLogo}
              alt={brandShort}
              width={200}
              height={48}
              priority
              className="h-10 w-auto object-contain object-left"
            />
          ) : (
            <div className="flex items-center gap-3">
              <BlueDotsLogo size={40} />
              <div className="font-display font-bold text-[18px] text-ink-900 leading-none tracking-tight">
                {brandShort}
              </div>
            </div>
          )}
          <LanguageSwitcher />
        </header>

        <div className="rounded-[18px] bg-white border border-[var(--bd-border)] overflow-hidden shadow-[0_1px_0_rgba(11,16,32,0.02),0_20px_60px_-30px_rgba(11,16,32,0.18)]">
          <div
            className="px-6 sm:px-8 py-6 text-white relative overflow-hidden"
            style={{ background: heroGradient }}
          >
            <div className="text-[11.5px] uppercase tracking-[0.14em] font-semibold text-white/70">
              {(() => {
                const d = cfg.domains?.find((x) => x.id === domain);
                return d?.label ?? d?.plural_label ?? domain;
              })()}
            </div>
            <h1 className="font-display font-bold text-[24px] sm:text-[28px] tracking-tight leading-tight mt-1.5">
              {eventLabel}
            </h1>
            {(orgName || locationLabel) && (
              <p className="text-[13.5px] text-white/85 mt-1.5">
                {orgName ? <span className="font-semibold">{orgName}</span> : null}
                {orgName && locationLabel ? <span className="text-white/60"> · </span> : null}
                {locationLabel}
              </p>
            )}
          </div>

          <div className="px-6 sm:px-8 py-7">
            {state.status === 'done' ? (
              <div className="rounded-[14px] border border-emerald-200 bg-emerald-50 p-6">
                <div className="flex items-center gap-2.5 font-display font-bold text-[18px] text-emerald-800">
                  <span className="w-7 h-7 rounded-full bg-emerald-500 text-white inline-flex items-center justify-center">
                    <I.check size={16} stroke={2.6} />
                  </span>
                  {state.outcome === 'passed' ? t('done_passed_title') : t('done_skipped_title')}
                </div>
                <p className="text-[14px] text-emerald-700 mt-3 leading-relaxed">
                  {state.outcome === 'passed' ? t('done_passed_body') : t('done_skipped_body')}
                </p>
                {state.submissionId ? (
                  <div className="text-[11px] text-emerald-600/80 font-mono mt-3">
                    {t('done_ref_prefix')} {state.submissionId}
                  </div>
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    setFormData({});
                    setShowValidation(false);
                    setState({ status: 'idle' });
                  }}
                  style={{ backgroundColor: cfg.brand.primary_color }}
                  className="mt-5 w-full py-3 rounded-[12px] font-display font-bold text-[15px] text-white hover:opacity-90 transition-opacity"
                >
                  {t('btn_register_another')}
                </button>
              </div>
            ) : (
              <>
                {state.status === 'error' ? (
                  <div
                    ref={errorRef}
                    role="alert"
                    tabIndex={-1}
                    className="mb-5 rounded-[10px] border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] text-rose-700 scroll-mt-6 outline-none"
                  >
                    <div className="font-semibold">{state.title}</div>
                    <div className="mt-1 text-rose-600">{state.detail}</div>
                    {state.code !== 'UNKNOWN' && (
                      <div className="mt-2 text-[11px] text-rose-500/80 font-mono">
                        Code: {state.code}
                      </div>
                    )}
                  </div>
                ) : null}

                {lookup?.kind === 'owned_elsewhere' ? (
                  <div
                    role="alert"
                    data-testid="lookup-owned-elsewhere"
                    className="mb-5 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800"
                  >
                    <div className="font-semibold">{t('lookup.owned_elsewhere_title')}</div>
                    <div className="mt-1 text-amber-700">{t('lookup.owned_elsewhere_body')}</div>
                    <button
                      type="button"
                      onClick={() => {
                        setLookup(null);
                        // Clear the offending identity fields so the user
                        // can edit and retry. Use the network's field
                        // selectors (config-driven) and fall back to the
                        // common keys. Other field values stay.
                        setFormData((prev) => {
                          const next = { ...prev };
                          for (const key of [
                            identity?.email,
                            identity?.phone,
                            'email',
                            'phone',
                            'phone_number',
                            'mobile',
                          ]) {
                            if (key) delete next[key];
                          }
                          return next;
                        });
                      }}
                      className="mt-3 text-[12px] font-semibold underline text-amber-900 hover:text-amber-700"
                    >
                      {t('lookup.owned_elsewhere_cta')}
                    </button>
                  </div>
                ) : null}

                {lookup?.kind === 'already_registered' ? (
                  <div
                    role="alert"
                    data-testid="lookup-already-registered"
                    className="mb-5 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800"
                  >
                    <div className="font-semibold">{t('lookup.already_registered_title')}</div>
                    <div className="mt-1 text-amber-700">{t('lookup.already_registered_body')}</div>
                    <button
                      type="button"
                      onClick={() => {
                        setLookup(null);
                        setFormData((prev) => {
                          const next = { ...prev };
                          for (const key of [
                            identity?.email,
                            identity?.phone,
                            'email',
                            'phone',
                            'phone_number',
                            'mobile',
                          ]) {
                            if (key) delete next[key];
                          }
                          return next;
                        });
                      }}
                      className="mt-3 text-[12px] font-semibold underline text-amber-900 hover:text-amber-700"
                    >
                      {t('lookup.already_registered_cta')}
                    </button>
                  </div>
                ) : null}

                {lookup?.kind === 'resume' ? (
                  <div
                    role="alert"
                    data-testid="lookup-resume"
                    className="mb-5 rounded-[10px] border border-sky-200 bg-sky-50 px-4 py-3 text-[13px] text-sky-800"
                  >
                    <div className="font-semibold">{t('lookup.resume_title')}</div>
                    <div className="mt-1 text-sky-700">{t('lookup.resume_body')}</div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          // Resume = let the upstream lifecycle parser
                          // dedup against the existing item by identity.
                          // No client-side state to thread: the server
                          // finds the same item_id via signalstack probe.
                          setLookup(null);
                          setBypassProbe(true);
                        }}
                        style={{ backgroundColor: cfg.brand.primary_color }}
                        className="px-3 py-2 rounded-[8px] font-semibold text-[12px] text-white hover:opacity-90"
                      >
                        {t('lookup.resume_cta')}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          // "New submission" = the user wants to register
                          // under different contact details. Clear the
                          // identity fields and DON'T bypass — so the new
                          // identity is re-probed on the next submit (rather
                          // than silently resuming the existing draft, which
                          // is what the "Resume" button above does).
                          setLookup(null);
                          setBypassProbe(false);
                          setFormData((prev) => {
                            const next = { ...prev };
                            for (const key of [
                              identity?.email,
                              identity?.phone,
                              'email',
                              'phone',
                              'phone_number',
                              'mobile',
                            ]) {
                              if (key) delete next[key];
                            }
                            return next;
                          });
                        }}
                        className="px-3 py-2 rounded-[8px] font-semibold text-[12px] text-sky-900 underline hover:text-sky-700"
                      >
                        {t('lookup.resume_continue_new')}
                      </button>
                    </div>
                  </div>
                ) : null}

                {/* Account-only links capture identity via MinimalIdentityForm
                    (the idle early-return). In the owned_elsewhere / resume /
                    error states we only show the banner above — never the RJSF
                    profile form or its submit button. */}
                {!isAccountOnly && (
                  <RjsfThemedForm
                    schema={formSchema}
                    uiSchema={mergedUiSchema as unknown as UiSchema<Record<string, unknown>>}
                    formData={formData}
                    onChange={(e) => setFormData(e.formData as Record<string, unknown>)}
                    onValidityChange={setCanSubmit}
                    onSubmit={handleSubmit}
                    // Only live-validate after the user has typed once OR
                    // attempted submit. Avoids the cold-start "every required
                    // field is red" look on first load.
                    liveValidate={showValidation}
                    showErrorList={showValidation ? 'top' : false}
                    focusOnFirstError
                    noHtml5Validate
                    onError={(errors) => {
                      setShowValidation(true);
                      const first = errors?.[0]?.message ?? t('validation_required');
                      setState({
                        status: 'error',
                        title: t('validation_error_title'),
                        detail: `${first}${errors.length > 1 ? ` ${t('validation_more', { count: errors.length - 1 })}` : ''}`,
                        code: 'VALIDATION',
                      });
                    }}
                  >
                    <div className="mt-4 flex flex-col gap-3">
                      <label className="block">
                        <span className="text-[14px] font-medium text-[var(--bd-fg)]">
                          {t('year_of_birth_label')}
                          <span className="text-rose-500 ml-0.5">*</span>
                        </span>
                        <select
                          value={yearOfBirth}
                          onChange={(e) => setYearOfBirth(e.target.value)}
                          className="mt-1 w-full rounded-[10px] border border-[var(--bd-border)] px-3 py-2 text-[14px]"
                          required
                        >
                          <option value="">{t('year_of_birth_placeholder')}</option>
                          {Array.from({ length: 101 }, (_, i) => currentYear - i).map((y) => (
                            <option key={y} value={String(y)}>
                              {y}
                            </option>
                          ))}
                        </select>
                      </label>
                      {isMinor ? (
                        // Minor: no consent here — Signals creates the account
                        // without it; terms are accepted in the Signalstack app
                        // after signing in. Submit still proceeds.
                        <div className="rounded-[12px] border border-[var(--bd-border)] bg-[var(--bd-primary-50)] px-4 py-3.5 text-[14px] text-[var(--bd-fg)]">
                          {t('u18_notice')}
                        </div>
                      ) : (
                        <div className="flex items-start gap-2.5 rounded-[12px] border border-[var(--bd-border)] px-4 py-3.5 text-[14px] text-[var(--bd-fg)]">
                          <input
                            id="consent-all"
                            type="checkbox"
                            checked={consentAccepted}
                            onChange={(e) => setConsentAccepted(e.target.checked)}
                            className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer"
                            aria-required
                          />
                          <span>
                            {consentContent ? (
                              <>
                                {t('consent_accept_prefix')}
                                <button
                                  type="button"
                                  className="underline text-[var(--bd-primary-600)]"
                                  onClick={() => setConsentModal({ open: true, tab: 'terms' })}
                                >
                                  {t('consent_docs_link')}
                                </button>
                                {t('consent_profile_conjunction')}
                                {consentContent.profileCreation && (
                                  <>
                                    {' '}
                                    <button
                                      type="button"
                                      className="underline text-[var(--bd-primary-600)]"
                                      onClick={() => setProfileConsentModal(true)}
                                    >
                                      {t('consent_profile_link')}
                                    </button>
                                  </>
                                )}
                              </>
                            ) : (
                              t('consent_label')
                            )}
                          </span>
                        </div>
                      )}
                      {(() => {
                        // Adults must accept both consents; a minor submits
                        // without consent (age + compliance omitted server-side).
                        const blocked =
                          state.status === 'submitting' ||
                          !canSubmit ||
                          !yobValid ||
                          (!isMinor && !consentAccepted);
                        return (
                          <button
                            type="submit"
                            disabled={blocked}
                            style={
                              blocked ? undefined : { backgroundColor: cfg.brand.primary_color }
                            }
                            className={`w-full py-3 rounded-[12px] font-display font-bold text-[15px] text-white transition-all
                    ${
                      blocked
                        ? 'bg-[var(--bd-primary-100)] text-[var(--bd-primary-600)] cursor-not-allowed'
                        : 'hover:opacity-90 bd-shadow-lg'
                    }`}
                          >
                            {state.status === 'submitting' ? t('btn_submitting') : t('btn_submit')}
                          </button>
                        );
                      })()}
                    </div>
                  </RjsfThemedForm>
                )}
              </>
            )}
          </div>
        </div>

        <p className="text-center text-[11.5px] text-ink-400 mt-6">
          {t('powered_by')}{' '}
          <span className="font-semibold" style={{ color: cfg.brand.primary_color }}>
            {brandShort}
          </span>
        </p>
      </div>
      {consentContent && (
        <ConsentModal
          open={consentModal.open}
          onOpenChange={(open) => setConsentModal((s) => ({ ...s, open }))}
          initialTab={consentModal.tab}
          content={consentContent}
        />
      )}
      {consentContent?.profileCreation && profileConsentModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="relative max-w-md w-full rounded-[14px] bg-white p-6 shadow-xl">
            <button
              type="button"
              aria-label={t('consent_profile_modal_close')}
              className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full text-ink-400 hover:bg-[var(--bd-primary-50)] hover:text-ink-700"
              onClick={() => setProfileConsentModal(false)}
            >
              <I.x size={18} />
            </button>
            <h2 className="font-display font-bold text-[16px] text-[var(--bd-fg)] pr-8">
              {t('consent_profile_modal_title')}
            </h2>
            <p className="mt-3 text-[14px] text-ink-700">
              {consentContent.profileCreation.statement}
            </p>
            <div className="mt-5 flex justify-end">
              <button
                type="button"
                className="rounded-[10px] px-4 py-2 text-[14px] font-semibold text-white"
                style={{ backgroundColor: cfg.brand.primary_color }}
                onClick={() => setProfileConsentModal(false)}
              >
                {t('consent_profile_modal_agree')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
