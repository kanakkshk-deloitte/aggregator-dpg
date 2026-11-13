'use client';

import type { JSX } from 'react';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { BlueDotsLogo } from '../../../components/ui/BlueDotsLogo';
import { BrandPanel } from '../../../components/login/BrandPanel';
import { useThemeMode } from '../../../lib/theme-mode';
import { I } from '../../../icons';
import { useAggregatorConfig, DEFAULT_AGGREGATOR_CONFIG } from '../../../hooks/useAggregatorConfig';
import { BrandAttribution } from '../../../components/login/BrandAttribution';
import { LegalLinksFooter } from '../../../components/legal/LegalLinksFooter';

export interface LoginViewProps {
  returnTo: string;
  error: string | null;
}

/**
 * Public login page with a single sign-in card that starts the BFF login flow.
 *
 * No credentials are collected here, and registration is not linked from this page.
 */
export function LoginView({ returnTo, error }: LoginViewProps): JSX.Element {
  const t = useTranslations('auth');
  const { data: cfg = DEFAULT_AGGREGATOR_CONFIG } = useAggregatorConfig();
  const brand = cfg.brand.short_name;
  // Use the light logo in dark mode, falling back to the default logo.
  const { mode } = useThemeMode();
  const headerLogo =
    mode === 'dark' ? (cfg.brand.logo?.light ?? cfg.brand.logo?.default) : cfg.brand.logo?.default;
  const goSignIn = (): void => {
    window.location.href = `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
  };

  return (
    <div className="h-screen w-full flex overflow-hidden">
      <BrandPanel />

      {/* Uses the `--bd-bg` token so the background follows dark mode. */}
      <div
        className="flex-1 min-w-0 h-screen flex flex-col px-6 py-8 relative overflow-y-auto"
        style={{ background: 'var(--bd-bg)' }}
      >
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none opacity-[0.55]"
          style={{
            backgroundImage: 'radial-gradient(rgba(37,99,235,0.07) 1px, transparent 1px)',
            backgroundSize: '22px 22px',
            maskImage: 'radial-gradient(ellipse 80% 70% at 50% 40%, #000 30%, transparent 80%)',
            WebkitMaskImage:
              'radial-gradient(ellipse 80% 70% at 50% 40%, #000 30%, transparent 80%)',
          }}
        />

        {/* Centres the card while the footer stays at the bottom of the pane. */}
        <div className="flex-1 flex items-center justify-center relative z-10">
          <div className="w-full max-w-[440px]">
            <div className="flex items-center gap-3 mb-7">
              {headerLogo ? (
                <Image
                  src={headerLogo}
                  alt={brand}
                  width={150}
                  height={40}
                  priority
                  className="h-10 w-auto object-contain object-left"
                />
              ) : (
                <span className="flex items-center gap-2.5">
                  <BlueDotsLogo size={40} />
                  <span className="font-display font-bold text-[20px] text-ink-900 leading-none tracking-tight">
                    {brand}
                  </span>
                </span>
              )}
              <span className="inline-flex items-center rounded-full bg-(--bd-primary-50) px-3 py-1.5 text-[13px] font-semibold text-(--bd-primary-600) whitespace-nowrap">
                Aggregator Portal
              </span>
            </div>

            {error ? (
              error === 'session_expired' ? (
                <div
                  role="alert"
                  className="mb-5 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800"
                >
                  {t('session_expired')}
                </div>
              ) : error === 'console_not_provisioned' ||
                error === 'console_no_org' ||
                error === 'signals_account_no_portal' ||
                error === 'no_portal_access' ||
                error === 'account_switch' ? (
                <div
                  role="alert"
                  className="mb-5 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800"
                >
                  {t(error)}
                  {/* Offer an account switch, which ends the realm SSO session
                      first. Not shown on `account_switch`, which is the state
                      after that logout. */}
                  {error !== 'account_switch' ? (
                    <a
                      href="/api/auth/login?switch=1"
                      className="mt-2 block font-semibold underline underline-offset-2"
                    >
                      {t('switch_account')}
                    </a>
                  ) : null}
                </div>
              ) : (
                <div
                  role="alert"
                  className="mb-5 rounded-[10px] border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700"
                >
                  {t('signin_failed', { reason: humanizeError(error, t) })}
                </div>
              )
            ) : null}

            <div className="fade-up">
              <Welcome onSignIn={goSignIn} brand={brand} t={t} />
            </div>

            {/* Registration is invite-only, so point users without an invite to
                their organisation. */}
            <p className="mt-6 text-[12.5px] text-ink-400">
              Need access? Contact your organisation administrator for an invitation.
            </p>

            <BrandAttribution rows={cfg.brand.attribution} />
          </div>
        </div>

        {/* Legal links at the bottom of the pane, outside the sign-in card. */}
        <LegalLinksFooter
          variant="sentence"
          className="relative z-10 mx-auto w-full max-w-[440px] pt-8"
        />
      </div>
    </div>
  );
}

type TFunction = ReturnType<typeof useTranslations<'auth'>>;

function humanizeError(code: string, t: TFunction): string {
  // Map known codes to fixed copy. Never render the raw code: it comes from
  // the query string and may be attacker-controlled.
  const knownKeys = [
    'invalid_flow_cookie',
    'missing_code_or_state',
    'oidc_error_temporarily_unavailable',
    'oidc_error_login_required',
    'oidc_error_access_denied',
    'oidc_error_invalid_request',
    'oidc_error_server_error',
    'exchange_token_exchange_failed',
    'exchange_state_mismatch',
    'exchange_token_verify_failed',
  ] as const;

  type ErrorKey = (typeof knownKeys)[number];
  const known = new Set<string>(knownKeys);

  if (known.has(code)) {
    return t(`errors.${code as ErrorKey}`);
  }
  return t('errors.unknown');
}

interface WelcomeProps {
  onSignIn: () => void;
  brand: string;
  t: TFunction;
}

/**
 * Sign-in welcome card with a single "Sign in" button.
 *
 * @param props - Sign-in callback, brand name, and translation function.
 */
function Welcome({ onSignIn, brand, t }: Readonly<WelcomeProps>): JSX.Element {
  return (
    <div>
      <h2 className="font-display font-bold text-[28px] text-ink-900 tracking-tight leading-tight">
        {t('welcome_heading')}
      </h2>
      <p className="text-[14px] text-ink-500 mt-2">{t('welcome_sub')}</p>

      <div className="grid grid-cols-1 gap-2.5 mt-7">
        <button
          type="button"
          onClick={onSignIn}
          className="group w-full flex items-center justify-between gap-4 p-4 pr-5 rounded-[14px] border text-left transition-all
                     border-(--bd-primary) bg-(--bd-tint-primary) hover:bg-(--bd-primary-50) dark:hover:bg-(--bd-tint-primary)"
        >
          <div className="flex items-center gap-3.5">
            <div
              className="w-9 h-9 rounded-[10px] flex items-center justify-center"
              style={{ background: 'color-mix(in srgb, var(--bd-primary) 14%, transparent)' }}
            >
              <I.lock size={16} className="text-primary-700" />
            </div>
            <div>
              <div className="font-display font-bold text-[15px] text-ink-900">
                {t('existing_title')}
              </div>
              <div className="text-[12.5px] text-ink-400 mt-0.5">
                {t('existing_sub', { brand })}
              </div>
            </div>
          </div>
          <div className="w-8 h-8 rounded-full flex items-center justify-center bg-(--bd-primary) text-white shrink-0">
            <I.arrowR size={14} />
          </div>
        </button>
      </div>
    </div>
  );
}
