'use client';

/**
 * Passes the enabled-locale list from the server to client components (web app i18n).
 *
 * The root layout resolves `ENABLED_LANGUAGES` per request and provides it
 * here, so the setting can change without a rebuild. Without a provider,
 * consumers get English only, which hides the switcher.
 */

import { createContext, useContext, type ReactNode } from 'react';
import { DEFAULT_LOCALE, type Locale } from './config';

const EnabledLocalesContext = createContext<readonly Locale[] | null>(null);

/**
 * Fallback when no provider is present: English only.
 *
 * The switcher needs two or more locales, so it hides itself.
 */
const FALLBACK_LOCALES: readonly Locale[] = [DEFAULT_LOCALE];

/**
 * Publishes the enabled locales to client components.
 *
 * @param value - The resolved locales, from `getEnabledLocales()` on the server.
 * @param children - Subtree that may call `useEnabledLocales`.
 */
export function EnabledLocalesProvider({
  value,
  children,
}: Readonly<{ value: readonly Locale[]; children: ReactNode }>) {
  return <EnabledLocalesContext.Provider value={value}>{children}</EnabledLocalesContext.Provider>;
}

/**
 * Returns the enabled locales resolved on the server for this request.
 *
 * @returns The enabled locales in display order, or `['en']` with no provider.
 */
export function useEnabledLocales(): readonly Locale[] {
  return useContext(EnabledLocalesContext) ?? FALLBACK_LOCALES;
}
