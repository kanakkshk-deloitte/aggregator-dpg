'use client';
/**
 * Blocking consent gate: every document in one continuous scroll, a progress
 * tracker above it, and a single agreement at the foot that unlocks only once
 * the reader has reached the end of the last document.
 *
 * {@link ConsentModal} is the separate, dismissible read-only viewer.
 *
 * @module apps/web/src/components/consent/ConsentGate
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowDown, Check, X } from 'lucide-react';
import { MarkdownContent } from '../forms/MarkdownContent';
import { ConsentProgressTracker } from './ConsentProgressTracker';
import { useReadProgress } from './read-progress';
import type { ConsentDoc } from './consent-docs';

/** Props for {@link ConsentGate}. */
export interface ConsentGateProps {
  /** Whether the gate is showing. */
  open: boolean;
  /** Documents to read, in order. */
  docs: ConsentDoc[];
  /** Surface-specific agreement wording beside the checkbox. */
  agreeLabel: string;
  /** Called when the reader accepts. */
  onAccept: () => void;
  /** Optional exit. Omit to make the gate impossible to close. */
  onCancel?: () => void;
}

/**
 * Renders the blocking consent gate.
 *
 * @param props - Open state, documents, agreement copy, and callbacks.
 * @returns The gate, or null when closed or there is nothing to show.
 */
export function ConsentGate({
  open,
  docs,
  agreeLabel,
  onAccept,
  onCancel,
}: Readonly<ConsentGateProps>): JSX.Element | null {
  // An empty list means the consent copy failed to load; callers handle that.
  if (!open || docs.length === 0) return null;

  // Mount the dialog only when open so `useReadProgress` sees a real element.
  return (
    <ConsentGateDialog
      docs={docs}
      agreeLabel={agreeLabel}
      onAccept={onAccept}
      onCancel={onCancel}
    />
  );
}

/** Props for {@link ConsentGateDialog}. */
interface ConsentGateDialogProps {
  docs: ConsentDoc[];
  agreeLabel: string;
  onAccept: () => void;
  // Explicit `| undefined` for exactOptionalPropertyTypes.
  onCancel?: (() => void) | undefined;
}

/**
 * The gate's dialog: tracker, reader, and footer. {@link ConsentGate} mounts
 * it only while open.
 *
 * `useReadProgress` attaches its listeners once, on mount, and does nothing if
 * the scroll ref is `null`. Mounting on open makes sure the ref points at the
 * real reader element when that effect runs.
 *
 * @param props - Documents, agreement copy, and callbacks.
 * @returns The dialog element.
 */
function ConsentGateDialog({
  docs,
  agreeLabel,
  onAccept,
  onCancel,
}: Readonly<ConsentGateDialogProps>): JSX.Element {
  const t = useTranslations('consent_gate');
  const readerRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [agreed, setAgreed] = useState(false);
  const progress = useReadProgress(readerRef, docs);

  // Move focus into the dialog on mount: the close button if present,
  // otherwise the reader.
  useEffect(() => {
    requestAnimationFrame(() => {
      if (onCancel) closeButtonRef.current?.focus();
      else readerRef.current?.focus();
    });
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/55 p-0 sm:items-center sm:p-4">
      {/* Backdrop only. Clicking it does not dismiss the gate. */}
      <div data-testid="consent-gate-backdrop" className="absolute inset-0" aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('title')}
        className="relative z-10 flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-[20px] bg-white shadow-2xl sm:max-w-lg sm:rounded-2xl"
      >
        <div className="flex shrink-0 items-start justify-between gap-4 px-5 pb-3 pt-5 sm:px-6 sm:pt-6">
          <div className="min-w-0">
            <p className="text-[11px] font-bold uppercase tracking-wide text-(--bd-primary-600)">
              {t('eyebrow')}
            </p>
            <h2 className="mt-0.5 font-display text-xl font-bold leading-tight text-ink-900">
              {t('title')}
            </h2>
            <p className="mt-1 text-sm text-ink-500">{t('description')}</p>
          </div>
          {onCancel && (
            <button
              ref={closeButtonRef}
              type="button"
              aria-label={t('close')}
              onClick={onCancel}
              className="shrink-0 rounded-lg p-1.5 text-ink-500 transition-colors hover:bg-slate-100 hover:text-ink-900"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          )}
        </div>

        <div className="shrink-0 px-4 pb-1 pt-3 sm:px-6">
          <ConsentProgressTracker docs={docs} progress={progress} />
        </div>

        <div className="flex min-h-0 flex-1 flex-col px-5 pt-3 sm:px-6">
          {/* A named `<section>` has the region role; the label gives it the name. */}
          <section
            ref={readerRef}
            data-testid="consent-reader"
            aria-label={t('reader_label')}
            // tabIndex 0 so keyboard users can reach and scroll the reader; the
            // gate cannot be completed without scrolling it.
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            // `relative` makes this scroller the positioning context for its sections.
            className="relative min-h-0 flex-1 overflow-y-auto rounded-xl border border-(--bd-border) bg-[#FBFCFF] p-4"
          >
            {docs.map((doc, i) => (
              <section
                key={doc.id}
                data-consent-section={doc.id}
                className={i > 0 ? 'mt-6 border-t border-slate-300 pt-5' : undefined}
              >
                <h3 className="mb-2 font-display text-[17px] font-bold text-ink-900">
                  {doc.title}
                </h3>
                <MarkdownContent content={doc.body} />
              </section>
            ))}
          </section>
        </div>

        <div className="mt-3 shrink-0 border-t border-(--bd-border) bg-[#FCFDFF] px-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-3 sm:px-6">
          <p
            className={`flex items-center gap-1.5 text-[11.5px] ${
              progress.allRead ? 'font-semibold text-emerald-600' : 'text-ink-500'
            }`}
          >
            {progress.allRead ? (
              <Check className="h-3 w-3 shrink-0" aria-hidden="true" />
            ) : (
              <ArrowDown className="h-3 w-3 shrink-0" aria-hidden="true" />
            )}
            {progress.allRead ? t('hint_done') : t('hint_scroll')}
          </p>

          <label
            className={`mt-2.5 flex items-start gap-3 rounded-xl border p-3 transition-colors ${
              progress.allRead
                ? 'border-(--bd-primary-600) bg-white'
                : 'border-(--bd-border) bg-slate-50 opacity-60'
            }`}
          >
            <input
              type="checkbox"
              checked={agreed}
              disabled={!progress.allRead}
              onChange={(e) => setAgreed(e.target.checked)}
              className="mt-0.5 h-[19px] w-[19px] shrink-0 accent-(--bd-primary-600)"
            />
            <span className="text-[13px] leading-relaxed text-ink-700">{agreeLabel}</span>
          </label>

          <button
            type="button"
            disabled={!progress.allRead || !agreed}
            onClick={onAccept}
            // Disabled state keeps the brand colour and label and only lowers
            // opacity, so the button stays visible.
            className="mt-3 w-full rounded-xl bg-(--bd-primary-600) py-3.5 text-[15px] font-bold text-white transition-all disabled:cursor-not-allowed disabled:opacity-60"
          >
            {t('accept')}
          </button>
        </div>
      </div>
    </div>
  );
}
