'use client';

/**
 * "Already registered — Sign in" option on the registration chooser, for a
 * participant who already has a Signals account.
 */

import { useTranslations } from 'next-intl';
import { resolveSignalsCta } from '@aggregator-dpg/network-config/signals-cta';
import { useAggregatorConfig, DEFAULT_AGGREGATOR_CONFIG } from '../../../hooks/useAggregatorConfig';

/**
 * Checks that a hand-off URL is absolute http(s) before it is used as an `href`.
 *
 * The API also validates these URLs at boot.
 *
 * @param url - Candidate URL from the `signals_ui_urls` payload.
 * @returns `true` for an absolute http(s) URL, `false` for anything else
 *   (`javascript:`, `data:`, protocol-relative, relative, unparseable).
 */
function isSafeHandoffUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

/**
 * Resolve the Signals UI URL for this link, or `null` when the hand-off is off.
 *
 * Both must hold: the link's registration mode has `signals_cta` enabled, and
 * the link's domain has a URL in `signals_ui_urls`. `null` means no chooser is
 * shown and the form renders directly. An unsafe URL is treated as absent.
 *
 * The URL should be the Signals UI `/auth/login` page, not a Keycloak URL
 * (which carries one-time `state` values); see `.env.example`.
 *
 * @param domain - The link's domain id (e.g. `seeker`).
 * @param registrationMode - The link's registration mode key, or `null`.
 * @param submissionShape - The link's resolved submission shape, used only as
 *   the fallback when the mode is absent from the config.
 * @returns The configured Signals UI URL, or `null` when the CTA is off.
 */
export function useSignalsHandoffUrl(
  domain: string,
  registrationMode: string | null,
  submissionShape: 'account_only' | 'account_and_profile',
): string | null {
  const { data: cfg = DEFAULT_AGGREGATOR_CONFIG } = useAggregatorConfig();
  const urls = cfg.signals_ui_urls;
  const url = urls && Object.hasOwn(urls, domain) ? urls[domain] : undefined;
  if (!url) return null;
  if (!isSafeHandoffUrl(url)) {
    console.error(
      `[signals-cta] refusing a non-http(s) hand-off URL for domain "${domain}"; the sign-in option will not render`,
      { operation: 'signals-cta.validate-url', status: 'rejected', domain },
    );
    return null;
  }
  const modes = cfg.registration_modes;
  const mode =
    registrationMode && modes && Object.hasOwn(modes, registrationMode)
      ? modes[registrationMode]
      : undefined;
  // The server sends `signals_cta`; when absent, use the shared default rule.
  const enabled = resolveSignalsCta(mode?.signals_cta, submissionShape);
  return enabled ? url : null;
}

/**
 * Renders the "Already Registered — Sign In" option of the chooser.
 *
 * Styled as a secondary (outlined) button next to Register.
 *
 * @param props.href - Signals UI URL from {@link useSignalsHandoffUrl}, used as is.
 * @returns The sign-in link, opened in a new tab.
 */
export function SignalsSignInCta({ href }: Readonly<{ href: string }>) {
  const t = useTranslations('profile.public_reg');
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="block w-full rounded-[12px] border border-(--bd-border) bg-white py-3 text-center font-display font-semibold text-[15px] text-ink-700 transition-colors hover:bg-(--bd-primary-50) hover:text-ink-900"
    >
      {t('signals_cta')}
    </a>
  );
}
