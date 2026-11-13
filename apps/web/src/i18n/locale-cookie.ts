'use server';

import { cookies } from 'next/headers';
import { DEFAULT_LOCALE, isEnabledLocale, LOCALE_COOKIE } from './config';

/**
 * Saves the chosen UI locale to the `NEXT_LOCALE` cookie.
 *
 * A locale that is not enabled is saved as the default locale.
 *
 * @param next - Requested locale code.
 */
export async function setLocale(next: string): Promise<void> {
  const value = isEnabledLocale(next) ? next : DEFAULT_LOCALE;
  (await cookies()).set(LOCALE_COOKIE, value, {
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
  });
}
