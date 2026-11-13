'use client';

/**
 * A modal confirmation: a title, a sentence and two buttons. Escape and
 * Cancel close it. The confirm button gets focus on open, Tab stays inside
 * the dialog, and focus returns to where it was on close.
 */

import { useEffect, useId, useRef } from 'react';
import { Button } from './Button';
import { buttonClass } from './button-class';

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel,
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: Readonly<{
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  /** Red confirm button, for an action that takes something away. */
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}>) {
  const titleId = useId();
  const bodyId = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  // The latest cancel handler, so a new function from the parent does not re-run the effect.
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        cancelRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])');
      if (!items || items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      before?.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[rgb(13_21_48/0.35)] p-5">
      <dialog
        ref={dialogRef}
        open
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="static m-0 w-[440px] max-w-full rounded-[16px] border-0 bg-(--bd-card) p-0 text-inherit shadow-2xl"
      >
        <div className="p-[22px]">
          <h3 id={titleId} className="font-display text-[17px] font-bold text-ink-900">
            {title}
          </h3>
          <p id={bodyId} className="mt-1.5 text-[13.5px] text-ink-500">
            {body}
          </p>
        </div>
        <div className="flex justify-end gap-2 border-t border-(--bd-border-soft) px-[22px] py-3.5">
          <Button kind="ghost" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <button
            ref={confirmRef}
            type="button"
            className={buttonClass(danger ? 'danger' : 'primary')}
            onClick={onConfirm}
            disabled={busy}
          >
            {confirmLabel}
          </button>
        </div>
      </dialog>
    </div>
  );
}
