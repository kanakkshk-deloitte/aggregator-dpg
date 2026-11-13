'use client';

/**
 * The Privacy / Terms links shown at the foot of the public surfaces.
 *
 * Used on the login page, org registration, and the public QR form. Links use
 * the brand colour and a permanent underline so they are visible on touch.
 *
 * Each link points to a section of `/legal`.
 *
 * @module components/legal/LegalLinksFooter
 */
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { JSX, ReactNode } from 'react';

/** Shared link styling. */
const LINK_CLASS =
  'font-medium text-(--bd-primary-600) underline underline-offset-2 transition-opacity hover:opacity-80';

/**
 * Tag renderers for the `agree_sentence` message.
 *
 * Module scope so they are not recreated on each render (Sonar S6478).
 */
const SENTENCE_LINKS = {
  privacy: (chunks: ReactNode) => (
    <Link href="/legal#privacy" className={LINK_CLASS}>
      {chunks}
    </Link>
  ),
  terms: (chunks: ReactNode) => (
    <Link href="/legal#terms" className={LINK_CLASS}>
      {chunks}
    </Link>
  ),
};

interface LegalLinksFooterProps {
  /**
   * Display style.
   *
   * `sentence` shows "By continuing you agree to ..." (login page).
   * `separated` shows "Privacy Policy · Terms of Service" for pages that
   * collect consent separately.
   */
  variant: 'sentence' | 'separated';
  className?: string;
}

export function LegalLinksFooter({
  variant,
  className,
}: Readonly<LegalLinksFooterProps>): JSX.Element {
  const t = useTranslations('legal');
  const tRegister = useTranslations('register');

  const privacy = (
    <Link href="/legal#privacy" className={LINK_CLASS}>
      {tRegister('consent.privacy_link')}
    </Link>
  );
  const terms = (
    <Link href="/legal#terms" className={LINK_CLASS}>
      {tRegister('consent.terms_link')}
    </Link>
  );

  if (variant === 'separated') {
    return (
      <div
        className={`flex items-center justify-center gap-3 text-[12.5px] text-ink-500 ${className ?? ''}`}
      >
        {privacy}
        <span aria-hidden="true">·</span>
        {terms}
      </div>
    );
  }

  return (
    <p className={`text-[12px] text-ink-500 ${className ?? ''}`}>
      {/* `t.rich` lets each language place the links in its own word order. */}
      {t.rich('agree_sentence', SENTENCE_LINKS)}
    </p>
  );
}
