import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Providers } from '../lib/providers';
import './globals.css';
import { NextIntlClientProvider } from 'next-intl';
import { getEnabledLocales } from '../i18n/config';
import { EnabledLocalesProvider } from '../i18n/EnabledLocalesProvider';
import { getFormRuntimeConfig } from '../lib/form-runtime-config';
import { FormRuntimeConfigProvider } from '../lib/FormRuntimeConfigProvider';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';

/**
 * Generates the page metadata from the active aggregator config.
 *
 * Falls back to a translated generic title if the api fetch fails.
 */
export async function generateMetadata(): Promise<Metadata> {
  try {
    const base = process.env.API_BASE_URL ?? 'http://localhost:4000';
    const res = await fetch(`${base}/v1/aggregator-config`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${res.status}`);
    const cfg = (await res.json()) as {
      brand: { long_name: string; tagline?: string };
    };
    return {
      title: `${cfg.brand.long_name}`,
      description:
        cfg.brand.tagline ?? `${cfg.brand.long_name} — track every participant in your network.`,
      // Brand-coloured favicon from `app/brand-icon/route.ts`. Do not add a
      // static `app/icon.svg`; it would override this route.
      icons: { icon: { url: '/brand-icon', type: 'image/svg+xml' } },
    };
  } catch {
    const t = await getTranslations('metadata');
    return {
      title: t('title'),
      description: t('description'),
      icons: { icon: { url: '/brand-icon', type: 'image/svg+xml' } },
    };
  }
}

// Applies the stored theme mode to <html> before hydration to avoid a
// light-theme flash. Defaults to light.
const themeNoFlashScript = `
(function () {
  try {
    var mode = localStorage.getItem('bd:theme-mode');
    if (mode === 'dark') document.documentElement.classList.add('dark');
  } catch (_) {}
})();
`;

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();
  // Read on the server per request so `ENABLED_LANGUAGES` is not inlined at build time.
  const enabledLocales = getEnabledLocales();
  // Runtime form settings (Maps key, reference datasets), passed via a provider
  // instead of `NEXT_PUBLIC_*` so they are not inlined at build time.
  const formRuntimeConfig = getFormRuntimeConfig();
  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeNoFlashScript }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap"
        />
      </head>
      <body>
        <NextIntlClientProvider locale={locale} messages={messages}>
          <EnabledLocalesProvider value={enabledLocales}>
            <FormRuntimeConfigProvider value={formRuntimeConfig}>
              <Providers>{children}</Providers>
            </FormRuntimeConfigProvider>
          </EnabledLocalesProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
