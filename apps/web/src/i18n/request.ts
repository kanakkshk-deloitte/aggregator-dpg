import { getRequestConfig } from 'next-intl/server';
import { cookies, headers } from 'next/headers';
import { resolveLocale, LOCALE_COOKIE } from './config';
import { applyTerms } from './terms';

/** Message catalogues with their terms filled, one per locale, built on first use. */
const catalogues = new Map<string, Record<string, unknown>>();

/**
 * Returns a locale's message catalogue with its term placeholders filled.
 *
 * @param locale - Resolved locale.
 * @returns The filled catalogue.
 */
async function loadMessages(locale: string): Promise<Record<string, unknown>> {
  const cached = catalogues.get(locale);
  if (cached) return cached;
  const raw = (await import(`./messages/${locale}.json`)).default as Record<string, unknown>;
  const filled = applyTerms(raw, locale);
  catalogues.set(locale, filled);
  return filled;
}

/**
 * Server-side per-request i18n config for next-intl (no-routing mode).
 *
 * Resolves the active locale from the NEXT_LOCALE cookie, falling back to the
 * Accept-Language header and then the default, and loads that locale's message
 * catalog with its term placeholders filled (see `terms.ts`).
 */
export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const headerStore = await headers();
  const locale = resolveLocale(
    cookieStore.get(LOCALE_COOKIE)?.value,
    headerStore.get('accept-language'),
  );
  return {
    locale,
    messages: await loadMessages(locale),
  };
});
