'use client';
/**
 * Contact-support modal.
 *
 * Optional subject + required message; POSTs to the BFF `POST /api/support`
 * (which forwards to the aggregator API's `POST /v1/support` and emails the
 * configured support address). Shows an inline success / unavailable
 * (SUPPORT_EMAIL not configured, 503) / error status rather than a toast —
 * matches the rest of the portal's inline-notice pattern (see
 * `ConsentModal`). Dismissible via the close button, overlay, or ESC.
 *
 * @module apps/web/src/components/support/SupportDialog
 */
import { useEffect, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { I } from '../../icons';
import { Button } from '../ui/Button';

/** Props for {@link SupportDialog}. */
export interface SupportDialogProps {
  /** Whether the dialog is currently visible. */
  open: boolean;
  /** Callback fired when the dialog should be closed (sets open to false). */
  onOpenChange: (open: boolean) => void;
}

type Status = 'idle' | 'sending' | 'success' | 'unavailable' | 'error' | 'invalid';

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
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  // Portal target only exists on the client; gate render until mounted so
  // the server pass (and first client paint) doesn't touch `document`.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Reset form state each time the dialog closes so re-opening starts fresh.
  useEffect(() => {
    if (!open) {
      setSubject('');
      setMessage('');
      setStatus('idle');
    }
  }, [open]);

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

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!message.trim()) {
      setStatus('invalid');
      return;
    }
    setStatus('sending');
    try {
      const res = await fetch('/api/support', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(subject.trim() ? { subject: subject.trim() } : {}),
          message: message.trim(),
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
      <div className="relative z-10 w-full max-w-md rounded-[14px] bg-[var(--bd-card)] border border-[var(--bd-border)] p-5">
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
              <label htmlFor="support-subject" className="block text-[13px] font-medium mb-1">
                {t('label_subject')}
              </label>
              <input
                id="support-subject"
                value={subject}
                maxLength={200}
                onChange={(e) => setSubject(e.target.value)}
                placeholder={t('placeholder_subject')}
                className="w-full rounded-[10px] border border-[var(--bd-border)] px-3 py-2 text-[14px] bg-transparent"
              />
            </div>
            <div>
              <label htmlFor="support-message" className="block text-[13px] font-medium mb-1">
                {t('label_message')}
              </label>
              <textarea
                id="support-message"
                value={message}
                required
                maxLength={5000}
                rows={5}
                onChange={(e) => setMessage(e.target.value)}
                placeholder={t('placeholder_message')}
                className="w-full rounded-[10px] border border-[var(--bd-border)] px-3 py-2 text-[14px] bg-transparent"
              />
            </div>
            {status === 'invalid' && (
              <p className="text-[13px] text-rose-600">{t('validation_message_required')}</p>
            )}
            {status === 'unavailable' && (
              <p className="text-[13px] text-amber-600">{t('unavailable')}</p>
            )}
            {status === 'error' && <p className="text-[13px] text-rose-600">{t('error')}</p>}
            <Button
              kind="primary"
              type="submit"
              disabled={status === 'sending'}
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
