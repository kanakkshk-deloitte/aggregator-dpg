'use client';

import Image from 'next/image';
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { ErrorSchema, RJSFSchema, UiSchema } from '@rjsf/utils';
import type { IChangeEvent } from '@rjsf/core';
import { useTranslations } from 'next-intl';
import { RjsfThemedForm } from '../../../components/forms/RjsfThemed';
import { readableFormErrors } from '../../../lib/readable-form-errors';
import type { ResolvedPlace } from '../../../components/forms/custom-widgets/LocationAutocompleteWidget';
import { BlueDotsLogo } from '../../../components/ui/BlueDotsLogo';
import { I } from '../../../icons';
import { useAggregatorConfig, DEFAULT_AGGREGATOR_CONFIG } from '../../../hooks/useAggregatorConfig';
import { registrationShowsConsent, domainRequiresBirthYear } from '../../../lib/registration-gates';
import { MinimalIdentityForm, type MinimalIdentityPayload } from './MinimalIdentityForm';
import { SignalsSignInCta, useSignalsHandoffUrl } from './SignalsSignInCta';
import { LanguageSwitcher } from '../../../components/shell/LanguageSwitcher';
import { ConsentGate } from '../../../components/consent/ConsentGate';
import { toConsentDocs } from '../../../components/consent/consent-docs';
import type { ParticipantConsent } from '../../../components/consent/consent-types';

/** Page background used by every state of the public registration page. */
const PAGE_BACKGROUND =
  'radial-gradient(1200px 600px at 50% -10%, var(--bd-tint-primary), transparent 70%), #FBFCFE';

export interface PublicRegistrationViewProps {
  org: string;
  slug: string;
  /**
   * Signalstack network id (e.g. 'blue_dot'), used by the pre-submit identity
   * probe. An empty string disables the probe.
   */
  network?: string;
  domain: string;
  context: Record<string, unknown>;
  schema: RJSFSchema;
  uiSchema: Record<string, unknown>;
  /**
   * Identity field names for the domain (name / phone / email). The
   * account_only form collects only these fields.
   */
  identity?: { name?: string; phone?: string; email?: string } | undefined;
  /**
   * Link submission shape. `account_only` renders identity fields only;
   * `account_and_profile` renders the full profile form.
   */
  submissionShape: 'account_only' | 'account_and_profile';
  /** Optional i18n key for a hint below the form. `null` means no hint. */
  publicHintI18nKey: string | null;
  /**
   * Registration mode key (e.g. `voice`, `form`). Voice links make the phone
   * number required on the minimal form.
   */
  registrationMode?: string | null;
  /**
   * Participant consent content: Terms, Privacy, and the profile-creation
   * statement. `null` when unavailable.
   */
  consentContent?: ParticipantConsent | null;
}

type SubmitState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'done'; submissionId: string; outcome: 'passed' | 'skipped' }
  | { status: 'error'; title: string; detail: string; code: string };

/**
 * Seconds before the post-submit hand-off to Signals.
 *
 * The success panel is the only place the submission reference id is shown,
 * so this gives the participant time to read it before the page navigates away.
 */
const SIGNALS_REDIRECT_SECONDS = 4;

/**
 * State of the post-submit hand-off countdown.
 *
 * The URL is captured when the countdown starts, so a config refetch during
 * the countdown cannot clear or change it. `navigating` is set before the
 * navigation call, so it fires at most once.
 */
type SignalsHandoff =
  { phase: 'counting'; url: string; seconds: number } | { phase: 'navigating'; url: string };

/**
 * Sends the participant to the Signals UI in the same tab.
 *
 * Do not use `window.open(url, '_blank')`: this runs from a timer, and
 * browsers block pop-ups opened without a user click. Errors from a blocked
 * navigation are logged; the button stays on screen.
 *
 * @param url - Hand-off URL captured when the countdown started.
 */
function navigateToSignals(url: string): void {
  try {
    window.location.assign(url);
  } catch (err) {
    console.error(
      '[signals-handoff] navigation to the Signals UI was blocked; the participant stays on the success panel',
      {
        operation: 'signals-handoff.navigate',
        status: 'failure',
        error: err instanceof Error ? err.message : String(err),
      },
    );
  }
}

/**
 * Outcome of the pre-submit identity probe: submit normally, or the identity
 * belongs to a different aggregator.
 */
type LookupOutcome = { kind: 'allow' } | { kind: 'owned_elsewhere' };

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
  /** Omitted by the server on the public path so a participant's row id is not exposed. */
  participant_id?: string | null;
  message?: string;
}

interface ApiErrorEnvelope {
  error?: {
    code?: string;
    title?: string;
    detail?: string;
    fields?: { field_errors?: unknown };
  };
}

/**
 * One coordinate saved with the profile. `lat`/`lng` must be numbers; Signals rejects strings.
 */
interface ItemLocation {
  lat: number;
  lng: number;
  label?: string;
}

/** Readable RJSF errors; kept exported here for existing callers. */
export { readableFormErrors };

/**
 * Turns the API's `fields.field_errors` (`{ "address.city": "message" }`) into
 * an RJSF error schema, so each rejected field is marked inline.
 *
 * @param fieldErrors - The `field_errors` map from an error response, if any.
 * @returns The error schema, or `undefined` when there is nothing to mark.
 */
export function toErrorSchema(fieldErrors: unknown): ErrorSchema | undefined {
  if (!fieldErrors || typeof fieldErrors !== 'object' || Array.isArray(fieldErrors)) {
    return undefined;
  }
  const root: Record<string, unknown> = {};
  let marked = false;
  for (const [path, message] of Object.entries(fieldErrors as Record<string, unknown>)) {
    if (typeof message !== 'string' || !path) continue;
    const segments = path.split('.');
    // Keys come from the server (and, through it, from Signals): a `__proto__`
    // segment would write onto Object.prototype, so such a path is skipped.
    if (segments.includes('__proto__')) continue;
    let node = root;
    for (const seg of segments) {
      if (!Object.hasOwn(node, seg)) node[seg] = {};
      node = node[seg] as Record<string, unknown>;
    }
    node['__errors'] = [...((node['__errors'] as string[] | undefined) ?? []), message];
    marked = true;
  }
  return marked ? (root as ErrorSchema) : undefined;
}

/**
 * Maps a schema property's custom markers to a uiSchema entry for a custom widget.
 *
 * Uses the same markers as the Signals profile form:
 *
 *  - `location: "primary" | "secondary"`: address autocomplete. Only a primary
 *    field's picked coordinate is saved.
 *  - `x-reference-source`: autocomplete backed by an external dataset, either a
 *    source id or `{ source, subtitle }`.
 *
 * Exported for tests.
 *
 * @param def - The property's JSON Schema.
 * @param type - The property's declared `type`, used to pick the array variant.
 * @returns A uiSchema entry for the field, or `null` if no marker applies.
 */
export function resolveMarkerUiSchema(
  def: Record<string, unknown>,
  type: unknown,
): Record<string, unknown> | null {
  const locationRole = def['location'];
  if (locationRole === 'primary' || locationRole === 'secondary') {
    const isArray = type === 'array';
    return {
      'ui:widget': isArray ? 'location-multi' : 'location-autocomplete',
      // Only the multi-row array variant spans both columns. The single-value
      // variant stays half width so the cell beside it is not left empty.
      ...(isArray ? { 'ui:colSpan': 2 } : {}),
      'ui:options': { isPrimaryLocation: locationRole === 'primary' },
    };
  }

  const marker = def['x-reference-source'];
  let source: string | undefined;
  let subtitleFields: string[] | undefined;
  if (typeof marker === 'string') {
    source = marker;
  } else if (marker && typeof marker === 'object') {
    const m = marker as { source?: unknown; subtitle?: unknown };
    if (typeof m.source === 'string') source = m.source;
    if (Array.isArray(m.subtitle)) {
      subtitleFields = m.subtitle.filter((s): s is string => typeof s === 'string');
    }
  }
  if (source) {
    return {
      'ui:widget': 'reference-autocomplete',
      // No colSpan: a single input stays half width.
      'ui:options': { source, ...(subtitleFields ? { subtitleFields } : {}) },
    };
  }

  return null;
}

/**
 * Renders the anonymous participant registration form.
 *
 * Submit POSTs to the BFF, which proxies to `/public/v1/registrations/create/:slug`.
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
  // Reuses the register forms' "consent unavailable" copy.
  const tRegister = useTranslations('register');
  const [formData, setFormData] = useState<Record<string, unknown>>({});
  /**
   * Whether the user chose "Register" on the chooser. Kept as view state, not
   * a route change, because printed QR codes encode `/<org>/<slug>` exactly.
   * Not used when the Signals hand-off is not configured.
   */
  const [formRevealed, setFormRevealed] = useState(false);
  const [state, setState] = useState<SubmitState>({ status: 'idle' });
  // Post-submit hand-off. `null` means no countdown is running.
  const [handoff, setHandoff] = useState<SignalsHandoff | null>(null);
  /**
   * Pre-submit probe outcome. `null` until the probe runs (or after "allow");
   * `owned_elsewhere` stops the submit and shows its banner.
   */
  const [lookup, setLookup] = useState<LookupOutcome | null>(null);
  // Show required-field errors only after the user types or tries to submit.
  const [showValidation, setShowValidation] = useState(false);
  // Field errors the server returned for the last submit, shown inline;
  // cleared as soon as the participant edits the form.
  const [serverFieldErrors, setServerFieldErrors] = useState<ErrorSchema | undefined>(undefined);
  // Coordinates the registrant picked from the address autocomplete, sent as
  // `item_locations` so Signals stores that point. Empty when nothing was
  // picked; Signals then geocodes the address text.
  const [resolvedLocations, setResolvedLocations] = useState<ItemLocation[]>([]);
  // One acceptance covering terms, privacy, and profile creation, collected by
  // ConsentGate. Once true, a retry does not reopen the gate.
  const [consentAccepted, setConsentAccepted] = useState(false);
  // Whether the consent gate is open.
  const [gateOpen, setGateOpen] = useState(false);
  // Form values held while the consent gate is open, submitted on accept.
  const pendingValuesRef = useRef<Record<string, unknown> | null>(null);
  /**
   * Year of birth for the submit the gate is holding. The account-only form
   * keeps this value in its own state.
   */
  const pendingYobRef = useRef<string | null>(null);
  // Age is derived from the birth year; no birthdate is stored. A minor
  // (age <= 18) submits without consent and accepts terms later in the
  // Signalstack app.
  const [yearOfBirth, setYearOfBirth] = useState('');
  const currentYear = new Date().getFullYear();
  const yobNum = Number(yearOfBirth.trim());
  const yobValid =
    /^\d{4}$/.test(yearOfBirth.trim()) && yobNum >= currentYear - 120 && yobNum <= currentYear;
  const derivedAge = yobValid ? currentYear - yobNum : Number.NaN;
  const isMinor = yobValid && derivedAge <= 18;
  const { data: cfgData, isError: cfgFailed } = useAggregatorConfig();
  const cfg = cfgData ?? DEFAULT_AGGREGATOR_CONFIG;
  /**
   * Whether the config query has finished, with data or with an error. Used to
   * pick chooser or form without a flash. On error the form renders without
   * the chooser so participants can still register.
   */
  const configResolved = cfgData !== undefined || cfgFailed;
  const brandShort = cfg.brand.short_name;
  const brandLogo = cfg.brand.logo?.default;
  // The consent step and birth-year field are set per domain in network.json.
  // See registrationShowsConsent and domainRequiresBirthYear.
  // Signals sign-in URL for existing participants. Resolved before the
  // account-only early return to keep hook order stable.
  const signalsHandoffUrl = useSignalsHandoffUrl(domain, registrationMode ?? null, submissionShape);
  const domainCfg = cfg.domains.find((d) => d.id === domain);
  const showBirthYear = domainRequiresBirthYear(domainCfg);
  const showConsent = registrationShowsConsent(domainCfg);
  const errorRef = useRef<HTMLDivElement>(null);
  // `account_only` renders MinimalIdentityForm instead of the RJSF form. Its
  // submit goes through the same consent gate with terms and privacy only.
  const isAccountOnly = submissionShape === 'account_only';
  // Consent documents for the gate. Empty when content is missing; submit
  // then shows an error instead of opening the gate.
  const consentDocs = useMemo(() => toConsentDocs(consentContent ?? undefined), [consentContent]);
  // One sentence covering terms, privacy, and profile creation.
  const agreeLabel = `${t('consent_accept_prefix')}${t('consent_docs_link')}${t('consent_profile_conjunction')}`;
  // Account-only creates no profile, so its gate shows terms and privacy only.
  // The API rejects `consent_profile` for this shape.
  const accountOnlyConsentDocs = useMemo(
    () =>
      toConsentDocs(
        consentContent
          ? { terms: consentContent.terms, privacy: consentContent.privacy }
          : undefined,
      ),
    [consentContent],
  );
  // Agreement wording without the profile-creation part.
  const accountOnlyAgreeLabel = `${t('consent_accept_prefix')}${t('consent_docs_link')}.`;
  // Documents and wording for the current form shape.
  const activeConsentDocs = isAccountOnly ? accountOnlyConsentDocs : consentDocs;
  const activeAgreeLabel = isAccountOnly ? accountOnlyAgreeLabel : agreeLabel;

  // On failure, scroll the error banner into view and focus it.
  useEffect(() => {
    if (state.status === 'error' && errorRef.current) {
      errorRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
      errorRef.current.focus();
    }
  }, [state]);

  // Start the countdown after a successful submit (`passed` or `skipped`) when
  // the hand-off is configured. A running countdown is kept as is; only a
  // cancel resets it.
  useEffect(() => {
    if (state.status !== 'done' || !signalsHandoffUrl) return;
    setHandoff(
      (prev) =>
        prev ?? { phase: 'counting', url: signalsHandoffUrl, seconds: SIGNALS_REDIRECT_SECONDS },
    );
  }, [state.status, signalsHandoffUrl]);

  useEffect(() => {
    if (handoff?.phase !== 'counting') return;
    if (handoff.seconds <= 0) {
      // Set `navigating` before navigating so this fires only once.
      setHandoff({ phase: 'navigating', url: handoff.url });
      navigateToSignals(handoff.url);
      return;
    }
    // Tick only while still counting, so a pending tick cannot undo a cancel.
    const timer = setTimeout(
      () =>
        setHandoff((prev) =>
          prev?.phase === 'counting' ? { ...prev, seconds: prev.seconds - 1 } : prev,
        ),
      1000,
    );
    return () => clearTimeout(timer);
  }, [handoff]);

  // Remove the schema title/description (the page header has its own) and
  // `participant_id`, which is bulk-upload only; the server creates one.
  const formSchema = useMemo<RJSFSchema>(() => {
    // Deep clone: the transforms below mutate nested objects, which must not
    // leak back into the `schema` prop.
    const clone: RJSFSchema = structuredClone(schema);
    delete (clone as { title?: string }).title;
    delete (clone as { description?: string }).description;
    const props = (clone as { properties?: Record<string, unknown> }).properties;
    if (props && 'participant_id' in props) {
      const { participant_id: _omit, ...rest } = props as Record<string, unknown>;
      (clone as { properties?: Record<string, unknown> }).properties = rest;
    }
    // Partial profiles are accepted: only identity fields stay required.
    // Signals marks an incomplete item `draft`. The server applies the same rule.
    const identityKeys = new Set(
      [identity?.name, identity?.phone, identity?.email].filter(
        (k): k is string => typeof k === 'string' && k.length > 0,
      ),
    );
    const required = (clone as { required?: string[] }).required;
    if (Array.isArray(required)) {
      (clone as { required?: string[] }).required = required.filter((r) => identityKeys.has(r));
    }
    // Inline `items.$ref` to `#/$defs/<x>` so RJSF's checkboxes widget gets its
    // enum options. RJSF does not resolve these refs for widget options.
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
            // Replace the ref with the resolved enum/type.
            const { $ref: _r, ...keep } = items as Record<string, unknown>;
            (inlined[field] as Record<string, unknown>).items = { ...target, ...keep };
          }
        }
        // RJSF fills `enumOptions` for array widgets only with `uniqueItems: true`.
        const resolvedItems = (inlined[field] as Record<string, unknown>).items as
          Record<string, unknown> | undefined;
        if (resolvedItems && Array.isArray(resolvedItems['enum'])) {
          (inlined[field] as Record<string, unknown>).uniqueItems = true;
        }
      }
      // RJSF seeds empty arrays and strings, which fail `minItems`/`minLength`.
      // Remove minimum constraints from non-identity fields so an identity-only
      // submit validates. enum/format/type checks stay.
      for (const [field, def] of Object.entries(inlined)) {
        if (identityKeys.has(field) || !def || typeof def !== 'object') continue;
        delete (def as Record<string, unknown>)['minItems'];
        delete (def as Record<string, unknown>)['minLength'];
        delete (def as Record<string, unknown>)['minimum'];
      }
    }
    return clone;
  }, [schema, identity]);

  // Default uiSchema: array fields use checkboxes or a comma-separated input,
  // array and boolean fields span full width, and required fields come first.
  // Caller-supplied uiSchema entries override these defaults.
  const mergedUiSchema = useMemo<Record<string, unknown>>(() => {
    const props = (schema as { properties?: Record<string, Record<string, unknown>> }).properties;
    const defs = (schema as { $defs?: Record<string, Record<string, unknown>> }).$defs ?? {};
    const resolveItemEnum = (itemsDef: Record<string, unknown> | undefined): string[] | null => {
      if (!itemsDef) return null;
      // Direct enum on items.
      if (Array.isArray(itemsDef['enum'])) return itemsDef['enum'] as string[];
      // $ref into $defs.
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
            // Enum arrays use checkboxes so only allowed values can be picked.
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
          // Full-width fields go last.
          tail.push(field);
        } else if (type === 'boolean') {
          defaults[field] = { 'ui:colSpan': 2 };
          tail.push(field);
        } else if (isRequired) {
          order.push(field);
        } else {
          tail.push(field);
        }

        // Schema markers override the type-based widget above.
        const marker = resolveMarkerUiSchema(def, type);
        if (marker) defaults[field] = marker;
      }
    }
    // When the schema declares `x-form-layout` sections, use their field order.
    // Otherwise use the required-first order above.
    const layoutOrder = (
      (schema as { 'x-form-layout'?: { sections?: Array<{ fields?: string[] }> } })['x-form-layout']
        ?.sections ?? []
    ).flatMap((section) => section.fields ?? []);

    return {
      'ui:order': layoutOrder.length > 0 ? [...layoutOrder, '*'] : [...order, ...tail, '*'],
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
   * Checks, before submit, whether the email or phone belongs to another aggregator.
   *
   * Returns `allow` when no identity is given, the network is unknown, the
   * BFF errors, or the contact is not owned elsewhere. A contact with profiles
   * under this aggregator is allowed; a participant may have more than one.
   *
   * @param values - Current RJSF formData.
   * @returns Branching outcome consumed by `handleSubmit`.
   */
  const runIdentityProbe = async (values: Record<string, unknown>): Promise<LookupOutcome> => {
    if (!network) return { kind: 'allow' };
    // Read identity using the network's field names, falling back to common keys.
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
      // Network error: submit normally; the API handles duplicates.
      return { kind: 'allow' };
    }
    if (!res.ok) return { kind: 'allow' };
    const body = (await res.json().catch(() => ({}))) as LookupResponse;
    if (body.owned_elsewhere) return { kind: 'owned_elsewhere' };
    // Existing profiles under this aggregator (live, draft, or paused) do not
    // block: the submit creates another profile. Signals enforces the profile
    // limit and returns `PROFILE_LIMIT_REACHED`. `lifecycle_summary` is not read.
    return { kind: 'allow' };
  };

  /**
   * Identity-only submit for `account_only` links.
   *
   * Passes the payload to {@link handleSubmit} as an RJSF-style event.
   */
  const handleMinimalSubmit = async (payload: MinimalIdentityPayload): Promise<void> => {
    await handleSubmit({ formData: payload as unknown as Record<string, unknown> } as IChangeEvent<
      Record<string, unknown>
    >);
  };

  /**
   * Posts the registration, either directly or after the consent gate is accepted.
   *
   * `consentGiven` is passed in because the `consentAccepted` state update is
   * not visible in this closure until the next render. `birthYear` is passed
   * in because the account-only form keeps it in its own state.
   *
   * @param values - RJSF formData (or the minimal-identity payload).
   * @param consentGiven - Whether to stamp consent_terms/privacy/profile true.
   * @param birthYear - Effective year of birth for this submit, already resolved.
   */
  const performSubmit = async (
    values: Record<string, unknown>,
    consentGiven: boolean,
    birthYear: string,
  ): Promise<void> => {
    setLookup(null);
    setState({ status: 'submitting' });
    try {
      const res = await fetch(
        `/api/${encodeURIComponent(org)}/${encodeURIComponent(slug)}/submit`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // The server accepts partial profiles (Signals marks them `draft`)
          // and records consent before building the profile. Consent flags
          // are sent only when the domain shows the consent step, and the
          // birth year only when the domain collects it. `consent_profile`
          // is not sent for `account_only`; the server rejects it there.
          body: JSON.stringify({
            ...values,
            ...(showConsent
              ? {
                  consent_terms: consentGiven,
                  consent_privacy: consentGiven,
                  ...(isAccountOnly ? {} : { consent_profile: consentGiven }),
                }
              : {}),
            ...(showBirthYear ? { year_of_birth: birthYear.trim() } : {}),
            // Picked coordinates. Omitted when none, so Signals geocodes the
            // address text. Never sent for account_only, which has no profile.
            ...(!isAccountOnly && resolvedLocations.length > 0
              ? { item_locations: resolvedLocations }
              : {}),
          }),
        },
      );
      // 409 with outcome=skipped means already registered here; show the done screen.
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
        const inline = toErrorSchema(body.error?.fields?.field_errors);
        if (inline) {
          setServerFieldErrors(inline);
          setShowValidation(true);
        }
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

  const handleSubmit = async (e: IChangeEvent<Record<string, unknown>>): Promise<void> => {
    const values = (e.formData ?? {}) as Record<string, unknown>;
    // Birth year for this submit: from the payload (account-only form) or
    // from this component's state (full-profile form).
    const yobRaw = values['year_of_birth'];
    const yobForSubmit = typeof yobRaw === 'string' ? yobRaw : yearOfBirth;
    const yobNumForSubmit = Number(yobForSubmit.trim());
    const yobValidForSubmit =
      /^\d{4}$/.test(yobForSubmit.trim()) &&
      yobNumForSubmit >= currentYear - 120 &&
      yobNumForSubmit <= currentYear;
    const isMinorForSubmit = yobValidForSubmit && currentYear - yobNumForSubmit <= 18;
    // Open the consent gate unless the registrant is a minor, the domain has
    // no consent step, or consent was already accepted this session.
    const needsConsentNow = showConsent && !isMinorForSubmit && !consentAccepted;
    // Pre-submit probe; always runs.
    setState({ status: 'submitting' });
    const outcome = await runIdentityProbe(values);
    if (outcome.kind !== 'allow') {
      setLookup(outcome);
      setState({ status: 'idle' });
      return;
    }
    setLookup(null);

    if (needsConsentNow) {
      // Consent content failed to load; show an error instead of an empty gate.
      if (activeConsentDocs.length === 0) {
        setState({
          status: 'error',
          title: tRegister('consent.load_failed_title'),
          detail: tRegister('consent.load_failed_detail'),
          code: 'CONSENT_UNAVAILABLE',
        });
        return;
      }
      pendingValuesRef.current = values;
      // Keep the birth year too; the account-only form holds it in its own state.
      pendingYobRef.current = yobForSubmit;
      setGateOpen(true);
      setState({ status: 'idle' });
      return;
    }

    await performSubmit(values, consentAccepted, yobForSubmit);
  };

  /** Accepting the gate: records consent, closes it, and resubmits. */
  const handleGateAccept = (): void => {
    setGateOpen(false);
    setConsentAccepted(true);
    void performSubmit(pendingValuesRef.current ?? {}, true, pendingYobRef.current ?? yearOfBirth);
  };

  // Consent gate rendered by both the account-only and full-profile branches.
  const consentGateElement = (
    <ConsentGate
      open={gateOpen}
      docs={activeConsentDocs}
      agreeLabel={activeAgreeLabel}
      onAccept={handleGateAccept}
      onCancel={() => setGateOpen(false)}
    />
  );

  // Hero fill: solid brand primary colour.
  const heroGradient = cfg.brand.primary_color ?? '#4338ca';

  // Show a placeholder until the config query finishes, so the chooser or
  // form does not flash. A failed query also finishes, with no hand-off.
  if (!configResolved) {
    return (
      <div
        className="bd-public-light min-h-screen w-full"
        style={{ background: PAGE_BACKGROUND }}
        aria-busy="true"
      >
        <div
          className={`${isAccountOnly ? 'max-w-[640px]' : 'max-w-[760px]'} mx-auto px-4 sm:px-6 lg:px-10 py-8 sm:py-12`}
        >
          <div
            data-testid="public-reg-loading"
            className="h-[300px] rounded-[18px] border border-(--bd-border) bg-white animate-pulse"
          />
        </div>
      </div>
    );
  }

  // Chooser between Register and Sign in, shown first when the Signals
  // hand-off is configured. Without a hand-off URL the form renders directly.
  const showChooser = signalsHandoffUrl !== null && !formRevealed;

  const chooserPanel = signalsHandoffUrl ? (
    <div data-testid="registration-chooser">
      <h2 className="font-display font-bold text-[19px] text-(--bd-fg) tracking-tight">
        {t('chooser_title')}
      </h2>
      <p className="mt-2 text-[14px] text-ink-500 leading-relaxed">{t('chooser_subtitle')}</p>
      <div className="mt-5 flex flex-col gap-3">
        <button
          type="button"
          onClick={() => setFormRevealed(true)}
          style={{ backgroundColor: cfg.brand.primary_color }}
          className="w-full py-3 rounded-[12px] font-display font-bold text-[15px] text-white hover:opacity-90 transition-opacity bd-shadow-lg"
        >
          {t('chooser_register_cta')}
        </button>
        <SignalsSignInCta href={signalsHandoffUrl} />
      </div>
    </div>
  ) : null;

  // Lets the user go back from the form to the chooser.
  const backToChooser =
    signalsHandoffUrl && formRevealed ? (
      <button
        type="button"
        onClick={() => setFormRevealed(false)}
        className="mb-4 inline-flex items-center gap-1 text-[13px] font-semibold text-ink-500 hover:text-ink-700"
      >
        <I.arrowL size={14} />
        {t('chooser_back')}
      </button>
    ) : null;

  /**
   * Visible label of the hand-off button, with the seconds left while counting.
   *
   * Shows the plain label once navigating. Visual only: the button's
   * accessible name is the plain label.
   */
  const continueToSignalsLabel =
    handoff?.phase === 'counting' && handoff.seconds > 0
      ? t('btn_continue_to_signals_counting', { seconds: handoff.seconds })
      : t('btn_continue_to_signals');

  /** Top margin of "Register another": smaller when the hand-off button is above it. */
  const registerAnotherSpacing = handoff ? 'mt-3' : 'mt-5';

  // Success panel shown after a submit succeeds.
  const donePanel =
    state.status === 'done' ? (
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
        {/* Live region is always mounted so screen readers announce text
            added to it. It announces once, without the per-second count. */}
        <p aria-live="polite" className="sr-only">
          {handoff ? t('signals_redirect_announcement') : ''}
        </p>
        {handoff ? (
          <button
            type="button"
            onClick={() => {
              // Stop the countdown first so it does not navigate a second time.
              const { url } = handoff;
              setHandoff(null);
              navigateToSignals(url);
            }}
            // Fixed accessible name so the per-second label is not announced.
            aria-label={t('btn_continue_to_signals')}
            style={{ backgroundColor: cfg.brand.primary_color }}
            className="mt-5 w-full py-3 rounded-[12px] font-display font-bold text-[15px] text-white hover:opacity-90 transition-opacity"
          >
            <span aria-hidden="true">{continueToSignalsLabel}</span>
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => {
            setFormData({});
            setShowValidation(false);
            setState({ status: 'idle' });
            // Reset consent and birth year for the next person, so they see
            // the consent gate and do not inherit the previous person's age.
            setConsentAccepted(false);
            setYearOfBirth('');
            pendingYobRef.current = null;
            // Cancel the hand-off so back-to-back registrations stay on this page.
            setHandoff(null);
          }}
          // Secondary outline button, below the primary hand-off button.
          className={`${registerAnotherSpacing} w-full py-3 rounded-[12px] border border-(--bd-border) bg-white font-display font-bold text-[15px] text-ink-700 hover:bg-ink-50 transition-colors`}
        >
          {t('btn_register_another')}
        </button>
      </div>
    ) : null;

  // Exactly one of the three panels below is active.
  let activeView: 'done' | 'chooser' | 'form';
  if (state.status === 'done') {
    activeView = 'done';
  } else if (showChooser) {
    activeView = 'chooser';
  } else {
    activeView = 'form';
  }

  // Render the account-only form while `idle` or `submitting`, so it stays
  // mounted and keeps its local field state during submit. `done` and
  // `error` fall through to the shared views below.
  if (isAccountOnly && (state.status === 'idle' || state.status === 'submitting') && !lookup) {
    return (
      <div
        className="bd-public-light min-h-screen w-full"
        style={{
          background: PAGE_BACKGROUND,
        }}
      >
        <div className="max-w-[640px] mx-auto px-4 sm:px-6 lg:px-10 py-8 sm:py-12">
          <div className="flex justify-end mb-3">
            <LanguageSwitcher />
          </div>
          {showChooser ? (
            <div className="rounded-[18px] bg-white border border-(--bd-border) px-6 sm:px-8 py-7 shadow-[0_1px_0_rgba(11,16,32,0.02),0_20px_60px_-30px_rgba(11,16,32,0.18)]">
              {chooserPanel}
            </div>
          ) : (
            <>
              {backToChooser}
              {/* `busy` is the form's only in-flight flag. */}
              <MinimalIdentityForm
                identity={identity ?? {}}
                onSubmit={handleMinimalSubmit}
                brandColor={heroGradient}
                hintI18nKey={publicHintI18nKey}
                requirePhone={registrationMode === 'voice'}
                showConsent={showConsent}
                showBirthYear={showBirthYear}
                busy={state.status === 'submitting'}
              />
            </>
          )}
        </div>
        {consentGateElement}
      </div>
    );
  }

  return (
    <div
      className="bd-public-light min-h-screen w-full"
      style={{
        background: PAGE_BACKGROUND,
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

        <div className="rounded-[18px] bg-white border border-(--bd-border) overflow-hidden shadow-[0_1px_0_rgba(11,16,32,0.02),0_20px_60px_-30px_rgba(11,16,32,0.18)]">
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
            {activeView === 'done' && donePanel}
            {activeView === 'chooser' && chooserPanel}
            {activeView === 'form' && (
              <>
                {backToChooser}
                {state.status === 'error' ? (
                  <div
                    ref={errorRef}
                    role="alert"
                    tabIndex={-1}
                    className="mb-5 rounded-[10px] border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] text-rose-700 scroll-mt-6 outline-hidden"
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
                        // Clear the identity fields so the user can retry.
                        // Other field values stay.
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

                {/* Account-only links show only the banner here, never the RJSF form. */}
                {!isAccountOnly && (
                  <RjsfThemedForm
                    schema={formSchema}
                    uiSchema={mergedUiSchema as unknown as UiSchema<Record<string, unknown>>}
                    formData={formData}
                    // Location widgets report resolved coordinates here; they
                    // read it as `registry.formContext`, not as a prop.
                    formContext={{
                      // Keep only lat/lng from the richer `ResolvedPlace`.
                      onLocationResolved: (place: ResolvedPlace | null) =>
                        setResolvedLocations(place ? [{ lat: place.lat, lng: place.lng }] : []),
                      // The multi-value widget already emits this shape.
                      onLocationsResolved: (coords: ItemLocation[]) => setResolvedLocations(coords),
                    }}
                    onChange={(e) => {
                      setFormData(e.formData as Record<string, unknown>);
                      if (serverFieldErrors) setServerFieldErrors(undefined);
                    }}
                    onSubmit={handleSubmit}
                    // Submit is never disabled by an invalid field: the click
                    // validates, reveals errors and lands in `onError`. Live
                    // validation starts only then.
                    liveValidate={showValidation}
                    showErrorList={showValidation ? 'top' : false}
                    focusOnFirstError
                    noHtml5Validate
                    transformErrors={(errors) => readableFormErrors(errors, formSchema)}
                    {...(serverFieldErrors ? { extraErrors: serverFieldErrors } : {})}
                    onError={(errors) => {
                      setShowValidation(true);
                      setState({
                        status: 'error',
                        title: t('validation_error_title'),
                        detail: errors.map((e) => e.stack).join(' ') || t('validation_required'),
                        code: 'VALIDATION',
                      });
                    }}
                  >
                    <div className="mt-4 flex flex-col gap-3">
                      {showBirthYear && (
                        <label className="block">
                          <span className="text-[14px] font-medium text-(--bd-fg)">
                            {t('year_of_birth_label')}
                            <span className="text-rose-500 ml-0.5">*</span>
                          </span>
                          <select
                            value={yearOfBirth}
                            onChange={(e) => setYearOfBirth(e.target.value)}
                            className="mt-1 w-full rounded-[10px] border border-(--bd-border) px-3 py-2 text-[14px]"
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
                      )}
                      {showConsent && isMinor && (
                        // Minor: no consent here; they accept terms in the
                        // Signalstack app later. Submit still proceeds.
                        <div className="rounded-[12px] border border-(--bd-border) bg-(--bd-primary-50) px-4 py-3.5 text-[14px] text-(--bd-fg)">
                          {t('u18_notice')}
                        </div>
                      )}
                      {(() => {
                        // Require a valid birth year only when the domain collects
                        // it. Consent does not disable the button; submit opens
                        // the consent gate when needed.
                        const blocked =
                          state.status === 'submitting' || (showBirthYear && !yobValid);
                        return (
                          <button
                            type="submit"
                            disabled={blocked}
                            // Same background and text colour in both states;
                            // disabled only lowers opacity.
                            style={{ backgroundColor: cfg.brand.primary_color }}
                            className={`w-full py-3 rounded-[12px] font-display font-bold text-[15px] text-white transition-all
                    ${blocked ? 'cursor-not-allowed opacity-60' : 'hover:opacity-90 bd-shadow-lg'}`}
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
      </div>
      {consentGateElement}
    </div>
  );
}
