/**
 * Locale constants and pure helpers for the web app's i18n.
 *
 * Has no `next/*` imports, so server and client code can import it.
 * `getEnabledLocales()` is server-only; client components use
 * `EnabledLocalesProvider` instead.
 */

export const SUPPORTED_LOCALES = ['en', 'kn', 'hi'] as const;

/** Cookie name that carries the user's chosen UI locale. */
export const LOCALE_COOKIE = 'NEXT_LOCALE';
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

/** Native display name per locale, shown in the language switcher. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  kn: 'ಕನ್ನಡ',
  hi: 'हिन्दी',
};

/** Type guard: is `v` one of the supported locale codes. */
export function isSupportedLocale(v: string | undefined | null): v is Locale {
  return !!v && (SUPPORTED_LOCALES as readonly string[]).includes(v);
}

/**
 * Parses a comma-separated locale list into the set shown in the switcher.
 *
 * `en` is always included, unsupported codes and duplicates are dropped, and
 * empty input means all supported locales.
 *
 * @param raw - Comma-separated locale codes, or undefined when unconfigured.
 * @returns The enabled locales, in display order.
 */
export function parseEnabledLocales(raw: string | undefined | null): Locale[] {
  if (!raw) return [...SUPPORTED_LOCALES];
  const requested = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is Locale => isSupportedLocale(s));
  const ordered = requested.includes(DEFAULT_LOCALE) ? requested : [DEFAULT_LOCALE, ...requested];
  const seen = new Set<Locale>();
  const result = ordered.filter((c) => (seen.has(c) ? false : (seen.add(c), true)));
  return result.length > 0 ? result : [...SUPPORTED_LOCALES];
}

/**
 * Locales shown in the switcher, from the `ENABLED_LANGUAGES` environment variable.
 *
 * Server-only: never call from a client component. Client components get the
 * list from `EnabledLocalesProvider`.
 *
 * Falls back to `NEXT_PUBLIC_ENABLED_LANGUAGES`. Uses `||` because Compose
 * sets an unset variable to an empty string.
 *
 * @returns The enabled locales, in display order.
 */
export function getEnabledLocales(): Locale[] {
  return parseEnabledLocales(
    process.env.ENABLED_LANGUAGES || process.env.NEXT_PUBLIC_ENABLED_LANGUAGES,
  );
}

/** True when `v` is supported AND enabled for this deployment. */
export function isEnabledLocale(v: string | undefined | null): v is Locale {
  return isSupportedLocale(v) && getEnabledLocales().includes(v);
}

/**
 * Resolves the active locale from the locale cookie and Accept-Language header.
 *
 * Order: an enabled cookie locale, then the first enabled Accept-Language
 * tag, then the default.
 *
 * @param cookieValue - The locale cookie value, if present.
 * @param acceptLanguage - The Accept-Language header string, or null.
 * @returns The resolved locale code.
 */
export function resolveLocale(
  cookieValue: string | undefined,
  acceptLanguage: string | null,
): Locale {
  if (isEnabledLocale(cookieValue)) return cookieValue;
  const tags = (acceptLanguage ?? '')
    .split(',')
    .map((t) => t.split(';')[0]?.trim().toLowerCase())
    .filter((t): t is string => Boolean(t));
  for (const tag of tags) {
    const base = tag.split('-')[0];
    if (isEnabledLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}
