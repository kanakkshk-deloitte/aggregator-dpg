'use client';

import { useTransition } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { Languages } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/Select';
import { LOCALE_NAMES } from '../../i18n/config';
import { useEnabledLocales } from '../../i18n/EnabledLocalesProvider';
import { setLocale } from '../../i18n/locale-cookie';

/**
 * Dropdown that switches the UI language. Options come from
 * `EnabledLocalesProvider`; choosing one sets the NEXT_LOCALE cookie and
 * refreshes the route. Hidden when fewer than two languages are enabled.
 *
 * Reads the list from context, not `process.env`, because client components
 * have env values inlined at build time.
 */
export function LanguageSwitcher() {
  const locale = useLocale();
  const t = useTranslations('language');
  const router = useRouter();
  const [, startTransition] = useTransition();
  const enabled = useEnabledLocales();

  if (enabled.length < 2) return null;

  function handleChange(next: string) {
    startTransition(async () => {
      await setLocale(next);
      router.refresh();
    });
  }

  return (
    <Select value={locale} onValueChange={handleChange}>
      <SelectTrigger aria-label={t('label')} className="w-auto gap-1.5 px-2.5 py-2">
        <Languages className="h-4 w-4 shrink-0 opacity-70" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {enabled.map((code) => (
          <SelectItem key={code} value={code}>
            {LOCALE_NAMES[code]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
