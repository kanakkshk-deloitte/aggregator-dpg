/**
 * Shown when a console record cannot be found or is out of the viewer's
 * reach: a plain message and a way back.
 */

import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { SearchX } from 'lucide-react';
import { buttonClass } from '@/components/ui/button-class';

export default async function ConsoleNotFound() {
  const t = await getTranslations('console.page_not_found');
  return (
    <section className="bd-card bd-shadow mx-auto mt-10 flex max-w-lg flex-col items-center gap-3 px-6 py-10 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-full bg-(--bd-primary-50) text-(--bd-primary-600)">
        <SearchX size={22} aria-hidden="true" />
      </span>
      <h1 className="font-display text-[20px] font-bold text-ink-900">{t('title')}</h1>
      <p className="text-[14px] text-ink-500">{t('body')}</p>
      <Link className={`${buttonClass('primary')} mt-2`} href="/console">
        {t('home')}
      </Link>
    </section>
  );
}
