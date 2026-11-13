'use client';
/**
 * Contact-support modal.
 *
 * Collects a support request: Name, Email, Phone (prefilled from the session
 * and editable), Type, Details, and a required consent checkbox. Submit needs
 * Details, at least one contact channel, and consent. Posts to
 * `POST /api/support`. Shows success, unavailable (503), or error inline.
 * Closes on the close button, overlay click, or ESC.
 *
 * @module apps/web/src/components/support/SupportDialog
 */
import { useEffect, useRef, useState, type ChangeEvent, type SubmitEvent, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { I } from '../../icons';
import { Button } from '../ui/Button';
import { useAuth } from '../../lib/auth-context';
import {
  SUPPORT_CONFIG_FALLBACK,
  encodeAttachments,
  formatBytes,
  pickerAccept,
  validateAttachmentSelection,
  type AttachmentRejection,
  type SupportConfig,
} from '../../lib/support-attachments';

/** Props for {@link SupportDialog}. */
export interface SupportDialogProps {
  /** Whether the dialog is currently visible. */
  open: boolean;
  /** Called when the dialog should close. */
  onOpenChange: (open: boolean) => void;
}

type Status =
  | 'idle'
  | 'sending'
  | 'success'
  | 'unavailable'
  | 'error'
  | 'invalid'
  | 'rate_limited'
  | 'attachment_rejected';
type SupportType = 'complaint' | 'support_request';

/**
 * Reads the API's `{ error: { code, detail } }` envelope from a failed
 * response. Handles a non-JSON body.
 *
 * @param res - The failed response.
 * @returns The error code and detail, or null when unreadable.
 */
async function readErrorCode(res: Response): Promise<{ code?: string; detail?: string } | null> {
  try {
    const body = (await res.json()) as { error?: { code?: string; detail?: string } };
    return body.error ?? null;
  } catch {
    return null;
  }
}

/** What the dialog should show after a submit response. */
interface SubmitOutcome {
  status: Status;
  /** Set to replace the inline attachment message; left undefined to keep it. */
  attachmentError?: string;
  /** Set to carry the API's own rejection detail (it names the file). */
  serverDetail?: string | null;
}

/**
 * Maps a submit response to what the dialog shows. Each failure keeps its own
 * message.
 *
 * @param res - The response from `POST /api/support`.
 * @param t - The `support` namespace translator.
 * @param config - Limits currently served by the API.
 * @returns The status plus any message to display with it.
 */
async function resolveSubmitOutcome(
  res: Response,
  t: (key: string, values?: Record<string, string | number>) => string,
  config: SupportConfig,
): Promise<SubmitOutcome> {
  if (res.status === 201) return { status: 'success' };
  if (res.status === 503) return { status: 'unavailable' };
  if (res.status === 429) return { status: 'rate_limited' };
  if (res.status === 413) {
    // Request body over the size limit; the handler never saw it.
    return {
      status: 'idle',
      attachmentError: t('attachment_too_large', { size: formatBytes(config.maxTotalBytes) }),
    };
  }
  // A server-side attachment rejection names the file, so show it.
  const error = await readErrorCode(res);
  if (error?.code?.startsWith('ATTACHMENT_')) {
    return { status: 'attachment_rejected', serverDetail: error.detail ?? null };
  }
  return { status: 'error' };
}

/**
 * Translates a client-side attachment rejection into the inline message shown
 * under the picker.
 *
 * @param rejection - The failed selection result.
 * @param t - The `support` namespace translator.
 * @param config - Limits currently served by the API.
 * @returns The translated message.
 */
function rejectionMessage(
  rejection: AttachmentRejection,
  t: (key: string, values?: Record<string, string | number>) => string,
  config: SupportConfig,
): string {
  if (rejection.reason === 'count') return t('attachment_too_many', { count: config.maxFiles });
  if (rejection.reason === 'size') {
    return t('attachment_too_large', { size: formatBytes(config.maxTotalBytes) });
  }
  return t('attachment_bad_type', { name: rejection.filename });
}

/**
 * Displays a modal contact-support form and relays submissions to the BFF.
 *
 * Returns null when `open` is false, so form state resets between openings.
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
  const [attachments, setAttachments] = useState<File[]>([]);
  /** Client-side attachment rejection, shown inline like the other notices. */
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  /** Server-side attachment rejection message; it names the file. */
  const [serverDetail, setServerDetail] = useState<string | null>(null);
  const [config, setConfig] = useState<SupportConfig>(SUPPORT_CONFIG_FALLBACK);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Render the portal only after mount, since `document` is client-only.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Reset the form and prefill from the session user each time it opens.
  useEffect(() => {
    if (open) {
      setName(user?.name ?? '');
      setEmail(user?.email ?? '');
      setPhone(user?.phone ?? '');
      setType('complaint');
      setDetails('');
      setConsent(false);
      setStatus('idle');
      setAttachments([]);
      setAttachmentError(null);
      setServerDetail(null);
    }
  }, [open, user]);

  // Attachment limits come from the API. If the fetch fails, defaults stay.
  useEffect(() => {
    if (!open) return;
    let active = true;
    void fetch('/api/support/config')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: SupportConfig | null) => {
        if (active && data) setConfig(data);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [open]);

  // Dismiss on ESC.
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

  const attachedBytes = attachments.reduce((sum, file) => sum + file.size, 0);

  const onFilesSelected = (e: ChangeEvent<HTMLInputElement>) => {
    const incoming = Array.from(e.target.files ?? []);
    // Clear the input so picking the same file again fires onChange.
    e.target.value = '';
    if (incoming.length === 0) return;

    const result = validateAttachmentSelection(attachments, incoming, config);
    if (!result.ok) {
      setAttachmentError(rejectionMessage(result, t, config));
      return;
    }
    setAttachmentError(null);
    setAttachments(result.files);
  };

  const removeAttachment = (index: number) => {
    setAttachmentError(null);
    setAttachments((current) => current.filter((_, i) => i !== index));
  };

  const submit = async (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canSubmit) {
      setStatus('invalid');
      return;
    }
    setStatus('sending');
    setServerDetail(null);
    try {
      // Encoding counts as sending, so the button is disabled during it.
      const encoded = attachments.length ? await encodeAttachments(attachments) : undefined;
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
          ...(encoded ? { attachments: encoded } : {}),
        }),
      });
      const outcome = await resolveSubmitOutcome(res, t, config);
      if (outcome.attachmentError !== undefined) setAttachmentError(outcome.attachmentError);
      if (outcome.serverDetail !== undefined) setServerDetail(outcome.serverDetail);
      setStatus(outcome.status);
    } catch {
      setStatus('error');
    }
  };

  const inputClass =
    // 16px below `sm` so iOS Safari does not zoom on focus.
    'w-full rounded-[10px] border border-(--bd-border) px-3 py-2 text-[16px] sm:text-[14px] bg-transparent';

  return createPortal(
    <div
      className="fixed inset-0 z-100 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t('title')}
    >
      {/* Invisible backdrop button: click outside to close. */}
      <button
        type="button"
        aria-label={t('cancel')}
        className="absolute inset-0 cursor-default"
        onClick={() => onOpenChange(false)}
        tabIndex={-1}
      />
      <div className="relative z-10 w-full max-w-md rounded-[14px] bg-(--bd-card) border border-(--bd-border) p-5 max-h-[90dvh] overflow-y-auto">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-[17px] font-semibold text-(--bd-fg)">{t('title')}</h2>
          <button
            type="button"
            aria-label={t('cancel')}
            onClick={() => onOpenChange(false)}
            className="text-(--bd-fg-muted) hover:text-(--bd-fg)"
          >
            <I.x size={18} />
          </button>
        </div>
        <p className="text-[13px] text-(--bd-fg-muted) mb-4">{t('description')}</p>

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
            <div>
              <label htmlFor="support-attachments" className="block text-[13px] font-medium mb-1">
                {t('label_attachments')}
              </label>
              <p className="text-[12px] text-(--bd-fg-muted) mb-2">
                {t('attachments_hint', {
                  count: config.maxFiles,
                  size: formatBytes(config.maxTotalBytes),
                })}
              </p>
              <input
                ref={fileInputRef}
                id="support-attachments"
                type="file"
                multiple
                accept={pickerAccept(config)}
                onChange={onFilesSelected}
                disabled={status === 'sending' || attachments.length >= config.maxFiles}
                className="sr-only"
              />
              <Button
                kind="ghost"
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={status === 'sending' || attachments.length >= config.maxFiles}
                className="text-[13px]"
              >
                {t('attachments_add')}
              </Button>
              {attachments.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {attachments.map((file, index) => (
                    <li
                      key={`${file.name}-${index}`}
                      className="flex items-center justify-between gap-2 rounded-[8px] border border-(--bd-border) px-2 py-1 text-[13px]"
                    >
                      <span className="truncate">{file.name}</span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span className="text-[12px] text-(--bd-fg-muted)">
                          {formatBytes(file.size)}
                        </span>
                        <button
                          type="button"
                          aria-label={t('attachments_remove', { name: file.name })}
                          onClick={() => removeAttachment(index)}
                          disabled={status === 'sending'}
                          className="text-(--bd-fg-muted) hover:text-(--bd-fg)"
                        >
                          <I.x size={14} />
                        </button>
                      </span>
                    </li>
                  ))}
                  <li className="text-[12px] text-(--bd-fg-muted)">
                    {t('attachments_total', {
                      used: formatBytes(attachedBytes),
                      total: formatBytes(config.maxTotalBytes),
                    })}
                  </li>
                </ul>
              )}
              {attachmentError && (
                <p className="mt-1 text-[13px] text-rose-600">{attachmentError}</p>
              )}
            </div>
            <label className="flex items-start gap-2 text-[13px] text-(--bd-fg)">
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
            {status === 'rate_limited' && (
              <p className="text-[13px] text-amber-600">{t('rate_limited')}</p>
            )}
            {status === 'attachment_rejected' && (
              <p className="text-[13px] text-rose-600">{serverDetail ?? t('error')}</p>
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
