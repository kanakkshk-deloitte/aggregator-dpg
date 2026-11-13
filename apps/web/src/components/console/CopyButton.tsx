'use client';

/**
 * A small icon button that copies a value to the clipboard and says so.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Copy } from 'lucide-react';

/** How long the copied state shows, in milliseconds. */
const COPIED_MS = 1800;

export function CopyButton({ value, label }: Readonly<{ value: string; label: string }>) {
  const t = useTranslations('console.coordinator');
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={label}
      title={copied ? t('copied') : label}
      className="grid h-6 w-6 place-items-center rounded-md text-ink-400 hover:bg-(--bd-border-soft) hover:text-ink-900"
    >
      {copied ? <Check size={13} className="text-emerald-600" /> : <Copy size={13} />}
      <span aria-live="polite" className="sr-only">
        {copied ? t('copied') : ''}
      </span>
    </button>
  );
}
