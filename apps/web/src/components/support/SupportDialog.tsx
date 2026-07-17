'use client';
/**
 * Contact-support modal.
 *
 * Collects a complaint / support request: Name, Email, Phone (all prefilled
 * from the session where available and editable), a Type selector, a Details
 * textarea, and a required consent checkbox. Submit is blocked until Details
 * is non-empty, at least one contact channel is filled, and consent is
 * checked. POSTs to the BFF `POST /api/support` (which forwards to the
 * aggregator API's `POST /v1/support` and emails the configured support
 * address). Shows an inline success / unavailable (SUPPORT_EMAIL not
 * configured, 503) / error status rather than a toast — matches the rest of
 * the portal's inline-notice pattern (see `ConsentModal`). Dismissible via
 * the close button, overlay, or ESC.
 *
 * @module apps/web/src/components/support/SupportDialog
 */
import { useEffect, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { I } from '../../icons';
import { Button } from '../ui/Button';
import { useAuth } from '../../lib/auth-context';

/** Props for {@link SupportDialog}. */
export interface SupportDialogProps {
  /** Whether the dialog is currently visible. */
  open: boolean;
  /** Callback fired when the dialog should be closed (sets open to false). */
  onOpenChange: (open: boolean) => void;
}

type Status = 'idle' | 'sending' | 'success' | 'unavailable' | 'error' | 'invalid';
type SupportType = 'complaint' | 'support_request';

/**
 * Displays a modal contact-support form and relays submissions to the BFF.
 *
 * Returns null when `open` is false so the form state does not linger
 * between openings.
 *
 * @param props - Open state and change handler.
 * @returns The modal overlay element, or null when closed.
 */
export function SupportDialog({ open, onOpenChange }: SupportDialogProps): JSX.Element | null {
  const t = useTranslations('support');
  const { user } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [type, setType] = useState<SupportType>('complaint');
  const [details, setDetails] = useState('');
  const [consent, setConsent] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  // Portal target only exists on the client; gate render until mounted so
  // the server pass (and first client paint) doesn't touch `document`.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Reset form state each time the dialog opens so re-opening starts fresh,
  // reseeding the prefill fields from the current session user.
  useEffect(() => {
    if (open) {
      setName(user?.name ?? '');
      setEmail(user?.email ?? '');
      setPhone(user?.phone ?? '');
      setType('complaint');
      setDetails('');
      setConsent(false);
      setStatus('idle');
    }
  }, [open, user]);

  // Dismiss on ESC, mirroring ConsentModal.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  if (!open || !mounted) return null;

  const hasContact = email.trim() !== '' || phone.trim() !== '';
  const canSubmit = details.trim() !== '' && hasContact && consent;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) {
      setStatus('invalid');
      return;
    }
    setStatus('sending');
    try {
      const res = await fetch('/api/support', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          ...(email.trim() ? { email: email.trim() } : {}),
          ...(phone.trim() ? { phone: phone.trim() } : {}),
          type,
          details: details.trim(),
          consent: true,
        }),
      });
      if (res.status === 201) {
        setStatus('success');
      } else if (res.status === 503) {
        setStatus('unavailable');
      } else {
        setStatus('error');
      }
    } catch {
      setStatus('error');
    }
  };

  const inputClass =
    'w-full rounded-[10px] border border-[var(--bd-border)] px-3 py-2 text-[14px] bg-transparent';

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t('title')}
    >
      {/* Invisible backdrop button captures click-outside-to-close (mirrors ConsentModal). */}
      <button
        type="button"
        aria-label={t('cancel')}
        className="absolute inset-0 cursor-default"
        onClick={() => onOpenChange(false)}
        tabIndex={-1}
      />
      <div className="relative z-10 w-full max-w-md rounded-[14px] bg-[var(--bd-card)] border border-[var(--bd-border)] p-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-[17px] font-semibold text-[var(--bd-fg)]">{t('title')}</h2>
          <button
            type="button"
            aria-label={t('cancel')}
            onClick={() => onOpenChange(false)}
            className="text-[var(--bd-fg-muted)] hover:text-[var(--bd-fg)]"
          >
            <I.x size={18} />
          </button>
        </div>
        <p className="text-[13px] text-[var(--bd-fg-muted)] mb-4">{t('description')}</p>

        {status === 'success' ? (
          <p className="text-[14px] text-emerald-600">{t('success')}</p>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <div>
              <label htmlFor="support-name" className="block text-[13px] font-medium mb-1">
                {t('label_name')}
              </label>
              <input
                id="support-name"
                value={name}
                maxLength={200}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('placeholder_name')}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="support-email" className="block text-[13px] font-medium mb-1">
                {t('label_email')}
              </label>
              <input
                id="support-email"
                type="email"
                value={email}
                maxLength={320}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t('placeholder_email')}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="support-phone" className="block text-[13px] font-medium mb-1">
                {t('label_phone')}
              </label>
              <input
                id="support-phone"
                type="tel"
                value={phone}
                maxLength={20}
                onChange={(e) => setPhone(e.target.value)}
                placeholder={t('placeholder_phone')}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="support-type" className="block text-[13px] font-medium mb-1">
                {t('label_type')}
              </label>
              <select
                id="support-type"
                value={type}
                onChange={(e) => setType(e.target.value as SupportType)}
                className={inputClass}
              >
                <option value="complaint">{t('type_complaint')}</option>
                <option value="support_request">{t('type_support_request')}</option>
              </select>
            </div>
            <div>
              <label htmlFor="support-details" className="block text-[13px] font-medium mb-1">
                {t('label_details')}
              </label>
              <textarea
                id="support-details"
                value={details}
                required
                maxLength={5000}
                rows={5}
                onChange={(e) => setDetails(e.target.value)}
                placeholder={t('placeholder_details')}
                className={inputClass}
              />
            </div>
            <label className="flex items-start gap-2 text-[13px] text-[var(--bd-fg)]">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                className="mt-0.5"
                aria-label={t('consent_label')}
              />
              <span>{t('consent_label')}</span>
            </label>
            {status === 'invalid' && (
              <p className="text-[13px] text-rose-600">{t('validation_incomplete')}</p>
            )}
            {status === 'unavailable' && (
              <p className="text-[13px] text-amber-600">{t('unavailable')}</p>
            )}
            {status === 'error' && <p className="text-[13px] text-rose-600">{t('error')}</p>}
            <Button
              kind="primary"
              type="submit"
              disabled={status === 'sending' || !canSubmit}
              className="w-full justify-center py-2.5 text-[14px] font-semibold"
            >
              {status === 'sending' ? t('sending') : t('submit')}
            </Button>
          </form>
        )}
      </div>
    </div>,
    document.body,
  );
}
