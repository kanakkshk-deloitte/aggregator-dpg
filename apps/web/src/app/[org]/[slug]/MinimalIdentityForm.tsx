/**
 * Identity-only registration form rendered when a public link has
 * the resolved `submission_shape === 'account_only'`. Collects name + phone or email +
 * consent and nothing else. The parent view (`PublicRegistrationView`)
 * passes the network's identity field names (e.g. `phone` vs
 * `mobile_number`) so the body posted to the API uses the right keys
 * for the link's domain. No RJSF, no profile schema, no `partial`
 * checkbox — the link itself locks the capture scope.
 *
 * Styled to match the rest of the public registration card chrome
 * (bd-card / bd-input / brand primary colour) so the user can't tell
 * this is a separate flow.
 */
'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { SubmitBlockers } from '../../../components/ui/SubmitBlockers';
import { ConsentModal, type ConsentTab } from '../../../components/consent/ConsentModal';
import type { ConsentDocContent } from '../../../components/consent/consent-types';

export interface MinimalIdentityPayload {
  /** Name field. Key is the network's `identity.name` selector. */
  [name: string]: string | boolean;
}

export interface MinimalIdentityFormProps {
  /**
   * Identity field selectors from the network config — the wire keys the
   * submitted body must use. `phone` / `email` may be undefined when the
   * domain doesn't declare them; the corresponding input is hidden.
   */
  identity: {
    name?: string;
    phone?: string;
    email?: string;
  };
  /** Submit handler — receives the identity-only payload. */
  onSubmit: (payload: MinimalIdentityPayload) => void | Promise<void>;
  /** Disables the submit button while the parent is in flight. */
  busy?: boolean;
  /**
   * Saturated brand colour for the header band + submit button. Caller
   * threads `cfg.brand.primary_color` through so the minimal form looks
   * native to the network (purple for purple_dot, sienna for orange_dot,
   * etc.). Falls back to `var(--bd-primary-600)`.
   */
  brandColor?: string;
  /**
   * Optional i18n key (resolved against the root message namespace) for a
   * hint rendered beneath the form — e.g. the voice-call notice declared on
   * the link's registration mode. `null` / undefined renders nothing.
   */
  hintI18nKey?: string | null;
  /**
   * Voice-mode capture: a phone number is mandatory and the email input is
   * hidden (the link's purpose is a call-back, so email is not collected).
   * When false (default), the classic "name + (phone OR email)" rule applies.
   */
  requirePhone?: boolean;
  /**
   * Participant Terms/Privacy copy for the consent modal (§4.1). `null` ⇒ the
   * consent line renders without a "view terms" link.
   */
  consentContent?: ConsentDocContent | null;
}

export function MinimalIdentityForm(props: MinimalIdentityFormProps): JSX.Element {
  const t = useTranslations('profile.public_reg.account_only');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [yearOfBirth, setYearOfBirth] = useState('');
  const [consentCall, setConsentCall] = useState(false);
  const consentContent = props.consentContent ?? null;
  const [consentModal, setConsentModal] = useState<{ open: boolean; tab: ConsentTab }>({
    open: false,
    tab: 'terms',
  });
  // Local double-submit guard. The parent runs an async probe before its own
  // `submitting` state flips, so this form can stay mounted for one render
  // after the click — a fast double-tap would otherwise fire two pipelines.
  const [submitting, setSubmitting] = useState(false);

  const nameKey = props.identity.name;
  const phoneKey = props.identity.phone;
  const emailKey = props.identity.email;
  const requirePhone = !!props.requirePhone;
  // Email is always shown when the domain declares it. In voice mode phone is
  // mandatory and email is optional; otherwise phone OR email is required.
  const showEmail = !!emailKey;

  // Identity invariant: name AND (voice → valid phone; otherwise valid phone
  // OR valid email). Format is checked here so a half-typed value (e.g. a
  // 4-digit mobile) blocks submit — and the blocker list says why.
  const hasName = name.trim().length > 0;
  const hasPhone = !!phoneKey && phone.trim().length > 0;
  const hasEmail = showEmail && email.trim().length > 0;
  const phoneFormatOk = phone.replace(/\D/g, '').length >= 10;
  const emailFormatOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const phoneValid = hasPhone && phoneFormatOk;
  const emailValid = hasEmail && emailFormatOk;
  // An entered email must be valid even when it's optional (voice mode).
  const emailOk = !hasEmail || emailFormatOk;
  const contactValid = requirePhone ? phoneValid : phoneValid || emailValid;
  // Year of birth → derived age (§4.4 snapshot: no birthdate stored). Age is
  // required with consent on guardian-gated domains; Signals rejects the push
  // (`AGE_REQUIRED`) otherwise.
  const currentYear = new Date().getFullYear();
  const yobNum = Number(yearOfBirth.trim());
  const yobValid =
    /^\d{4}$/.test(yearOfBirth.trim()) && yobNum >= currentYear - 120 && yobNum <= currentYear;
  const derivedAge = yobValid ? currentYear - yobNum : NaN;
  // U18 (§4.4): a minor cannot establish consent here — they accept terms in
  // the Signalstack app after signing in. The submit still goes through (the
  // API omits age + consent for a minor so Signals creates the account); we
  // just don't collect/require consent. Fail-closed at the boundary: age <= 18.
  const isMinor = yobValid && derivedAge <= 18;
  const valid = hasName && contactValid && emailOk && yobValid && (isMinor || consentCall);

  // Option B: the submit stays disabled until valid, but we surface exactly
  // what is blocking so the user is never left guessing.
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
  if (!yobValid) blockers.push(t('blockers.year_of_birth'));
  if (!isMinor && !consentCall) blockers.push(t('blockers.consent_call'));

  return (
    <div className="rounded-[18px] bg-white border border-[var(--bd-border)] overflow-hidden shadow-[0_1px_0_rgba(11,16,32,0.02),0_20px_60px_-30px_rgba(11,16,32,0.18)]">
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
          if (!valid || !nameKey || submitting) return;
          setSubmitting(true);
          const payload: MinimalIdentityPayload = {
            [nameKey]: name.trim(),
            // Year of birth (§4.4); the API derives age and forwards it as the
            // top-level `age` required with consent on gated domains.
            year_of_birth: yearOfBirth.trim(),
            // Drive the transmitted consent from the actual checkbox, not a
            // hardcoded `true`. Submit is already gated on `consentCall`, but
            // the backend now validates these server-side (#522) and rejects
            // with CONSENT_REQUIRED when either is not `true`.
            consent_terms: consentCall,
            consent_privacy: consentCall,
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

        {isMinor ? (
          // Minor: no consent here — Signals creates the account without it and
          // the participant accepts terms in the Signalstack app after signing in.
          <div className="rounded-[10px] border border-[var(--bd-border)] bg-[var(--bd-primary-50)] px-4 py-3.5 text-[13.5px] text-ink-900">
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
                className="mt-0.5 h-4 w-4 rounded border-[var(--bd-border)] accent-[var(--bd-primary-600)]"
              />
              <span>{t('consent_call_label')}</span>
            </label>
            {consentContent && (
              <p className="text-[12px] text-ink-500">
                {t('consent_accept_prefix')}
                <button
                  type="button"
                  className="underline text-[var(--bd-primary-600)]"
                  onClick={() => setConsentModal({ open: true, tab: 'terms' })}
                >
                  {t('consent_docs_link')}
                </button>
                .
              </p>
            )}
          </div>
        )}

        {!valid && <SubmitBlockers reasons={blockers} heading={t('blockers.heading')} />}

        <div className="flex justify-end pt-2">
          <button
            type="submit"
            disabled={!valid || submitting || props.busy}
            style={{ background: props.brandColor ?? undefined }}
            className="inline-flex items-center justify-center rounded-[10px] px-5 py-2.5 text-[14px] font-semibold text-white bg-[var(--bd-primary-600)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition"
          >
            {t('submit_label')}
          </button>
        </div>
      </form>
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
