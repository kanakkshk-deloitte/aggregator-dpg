/**
 * Identity-only registration form for links with `submission_shape === 'account_only'`.
 *
 * Collects name, phone or email, and optional consent and birth year. The
 * parent passes the network's identity field names so the payload uses the
 * right keys for the domain.
 */
'use client';

import { useState, type JSX } from 'react';
import { useTranslations } from 'next-intl';
import { SubmitBlockers } from '../../../components/ui/SubmitBlockers';

export interface MinimalIdentityPayload {
  /** Name field. Key is the network's `identity.name` selector. */
  [name: string]: string | boolean;
}

export interface MinimalIdentityFormProps {
  /**
   * Identity field names from the network config, used as payload keys.
   * An undefined `phone` or `email` hides that input.
   */
  identity: {
    name?: string;
    phone?: string;
    email?: string;
  };
  /** Submit handler; receives the identity-only payload. */
  onSubmit: (payload: MinimalIdentityPayload) => void | Promise<void>;
  /**
   * Disables the submit button while the parent's submit is in flight. This
   * is the form's only in-flight guard; it has no local `submitting` state.
   */
  busy?: boolean;
  /** Brand colour for the header band and submit button. Defaults to `var(--bd-primary-600)`. */
  brandColor?: string;
  /** Optional i18n key (root namespace) for a hint below the form. */
  hintI18nKey?: string | null;
  /**
   * Voice mode: phone is required and email is optional. When false
   * (default), name plus phone or email is required.
   */
  requirePhone?: boolean;
  /**
   * Show the consent checkbox. Set when the domain's `go_live_required`
   * includes `consent_required`.
   */
  showConsent: boolean;
  /**
   * Collect a birth year. Set when the domain has `guardian_consent_required`.
   */
  showBirthYear: boolean;
}

/**
 * Checks whether a value looks like an email, for the inline blocker list.
 *
 * Requires one `@`, no whitespace, and a dot inside the domain. Uses index
 * scans instead of a regex to avoid slow backtracking. The server does the
 * real validation.
 *
 * @param value - Trimmed contents of the email field.
 * @returns True when the value is plausibly an email address.
 */
function looksLikeEmail(value: string): boolean {
  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@')) return false;
  const domain = value.slice(at + 1);
  if (domain.length === 0) return false;
  if (/\s/.test(value)) return false;
  const dot = domain.indexOf('.');
  return dot > 0 && dot < domain.length - 1;
}

export function MinimalIdentityForm(props: MinimalIdentityFormProps): JSX.Element {
  const t = useTranslations('profile.public_reg.account_only');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [yearOfBirth, setYearOfBirth] = useState('');
  const [consentCall, setConsentCall] = useState(false);

  const nameKey = props.identity.name;
  const phoneKey = props.identity.phone;
  const emailKey = props.identity.email;
  const requirePhone = !!props.requirePhone;
  // Email is always shown when the domain declares it. In voice mode phone is
  // mandatory and email is optional; otherwise phone OR email is required.
  const showEmail = !!emailKey;

  // Requires a name and, in voice mode, a valid phone; otherwise a valid phone
  // or email. Partial values block submit and appear in the blocker list.
  const hasName = name.trim().length > 0;
  const hasPhone = !!phoneKey && phone.trim().length > 0;
  const hasEmail = showEmail && email.trim().length > 0;
  const phoneFormatOk = phone.replace(/\D/g, '').length >= 10;
  const emailFormatOk = looksLikeEmail(email.trim());
  const phoneValid = hasPhone && phoneFormatOk;
  const emailValid = hasEmail && emailFormatOk;
  // An entered email must be valid even when it's optional (voice mode).
  const emailOk = !hasEmail || emailFormatOk;
  const contactValid = requirePhone ? phoneValid : phoneValid || emailValid;
  // Age is derived from the birth year; no birthdate is stored. Guardian-gated
  // domains need it, or Signals rejects the submit with `AGE_REQUIRED`.
  const currentYear = new Date().getFullYear();
  const yobNum = Number(yearOfBirth.trim());
  const yobValid =
    /^\d{4}$/.test(yearOfBirth.trim()) && yobNum >= currentYear - 120 && yobNum <= currentYear;
  const derivedAge = yobValid ? currentYear - yobNum : Number.NaN;
  // Minors (age <= 18) do not give consent here; they accept terms in the
  // Signalstack app after signing in. The submit still goes through.
  const isMinor = yobValid && derivedAge <= 18;
  const valid =
    hasName &&
    contactValid &&
    emailOk &&
    (!props.showBirthYear || yobValid) &&
    (!props.showConsent || isMinor || consentCall);

  // Submit stays disabled until valid; list what is blocking it.
  const blockers: string[] = [];
  if (!hasName) blockers.push(t('blockers.name'));
  if (requirePhone) {
    if (!hasPhone) blockers.push(t('blockers.phone_required'));
    else if (!phoneFormatOk) blockers.push(t('blockers.phone_invalid'));
    if (hasEmail && !emailFormatOk) blockers.push(t('blockers.email_invalid'));
  } else if (!hasPhone && !hasEmail) {
    blockers.push(t('blockers.contact_required'));
  } else {
    if (hasPhone && !phoneFormatOk) blockers.push(t('blockers.phone_invalid'));
    if (hasEmail && !emailFormatOk) blockers.push(t('blockers.email_invalid'));
  }
  if (props.showBirthYear && !yobValid) blockers.push(t('blockers.year_of_birth'));
  if (props.showConsent && !isMinor && !consentCall) blockers.push(t('blockers.consent_call'));

  return (
    <div className="rounded-[18px] bg-white border border-(--bd-border) overflow-hidden shadow-[0_1px_0_rgba(11,16,32,0.02),0_20px_60px_-30px_rgba(11,16,32,0.18)]">
      <div
        className="px-6 sm:px-8 py-6 text-white"
        style={{ background: props.brandColor ?? 'var(--bd-primary-600)' }}
      >
        <h1 className="font-display font-bold text-[22px] sm:text-[26px] tracking-tight leading-tight">
          {t('title')}
        </h1>
        <p className="text-[13.5px] text-white/85 mt-1.5">{t('helper')}</p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid || !nameKey || props.busy) return;
          const payload: MinimalIdentityPayload = {
            [nameKey]: name.trim(),
            // Send the birth year only when the domain collects it. The parent
            // view adds `consent_terms` / `consent_privacy` after its consent
            // gate. `consentCall` is permission to call the registrant, not
            // terms/privacy acceptance.
            ...(props.showBirthYear ? { year_of_birth: yearOfBirth.trim() } : {}),
          };
          if (phoneKey && hasPhone) payload[phoneKey] = phone.trim();
          if (emailKey && hasEmail) payload[emailKey] = email.trim();
          void props.onSubmit(payload);
        }}
        noValidate
        className="px-6 sm:px-8 py-7 flex flex-col gap-5"
      >
        <label className="block">
          <span className="bd-label">
            {t('name_label')}
            <span className="text-rose-500 ml-0.5">*</span>
          </span>
          <input
            className="bd-input"
            type="text"
            name={nameKey ?? 'name'}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoComplete="name"
          />
        </label>

        {props.showBirthYear && (
          <label className="block">
            <span className="bd-label">
              {t('year_of_birth_label')}
              <span className="text-rose-500 ml-0.5">*</span>
            </span>
            <select
              className="bd-input"
              name="year_of_birth"
              value={yearOfBirth}
              onChange={(e) => setYearOfBirth(e.target.value)}
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

        {(phoneKey || showEmail) && (
          <div>
            {!requirePhone && (
              <div className="text-[12px] text-ink-500 mb-2">{t('contact_label')}</div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {phoneKey && (
                <label className="block">
                  <span className="bd-label">
                    {t('phone_label')}
                    {requirePhone && <span className="text-rose-500 ml-0.5">*</span>}
                  </span>
                  <input
                    className="bd-input"
                    type="tel"
                    name={phoneKey}
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    autoComplete="tel"
                    placeholder="+91..."
                    required={requirePhone}
                  />
                </label>
              )}
              {showEmail && (
                <label className="block">
                  <span className="bd-label">{t('email_label')}</span>
                  <input
                    className="bd-input"
                    type="email"
                    name={emailKey}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                    placeholder="you@example.com"
                  />
                </label>
              )}
            </div>
          </div>
        )}

        {props.showConsent &&
          (isMinor ? (
            // Minor: no consent here; they accept terms in the Signalstack app later.
            <div className="rounded-[10px] border border-(--bd-border) bg-(--bd-primary-50) px-4 py-3.5 text-[13.5px] text-ink-900">
              {t('u18_notice')}
            </div>
          ) : (
            <div className="flex flex-col gap-2.5 pt-1">
              <label className="flex items-start gap-2.5 text-[13px] text-ink-900 cursor-pointer">
                <input
                  type="checkbox"
                  name="consent_call"
                  checked={consentCall}
                  onChange={(e) => setConsentCall(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded-sm border-(--bd-border) accent-(--bd-primary-600)"
                />
                <span>{t('consent_call_label')}</span>
              </label>
            </div>
          ))}

        {!valid && <SubmitBlockers reasons={blockers} heading={t('blockers.heading')} />}

        <div className="flex justify-end pt-2">
          <button
            type="submit"
            disabled={!valid || props.busy}
            style={{ background: props.brandColor ?? undefined }}
            className="inline-flex items-center justify-center rounded-[10px] px-5 py-2.5 text-[14px] font-semibold text-white bg-(--bd-primary-600) hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition"
          >
            {t('submit_label')}
          </button>
        </div>
      </form>
    </div>
  );
}
