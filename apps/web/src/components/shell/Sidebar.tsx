'use client';

import { useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { I, type IconName } from '../../icons';
import { BlueDotsLogo } from '../ui/BlueDotsLogo';
import { useAuth } from '../../lib/auth-context';
import { useThemeMode } from '../../lib/theme-mode';
import { SupportDialog } from '../support/SupportDialog';
import { Button } from '../ui/Button';
// `mode` is also read here to swap to the light-on-dark logo variant
// when the user is in dark theme — toggle UI itself lives in Topbar.
import { useDashboard } from '../../hooks/useDashboard';
import { useProfileRaw } from '../../hooks/useProfile';
import { useAggregatorConfig, DEFAULT_AGGREGATOR_CONFIG } from '../../hooks/useAggregatorConfig';
import { cn } from '../../lib/cn';

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  badge?: number;
}

/**
 * Returns the stable route/icon structure for the side-nav.
 * Labels are resolved by the component using the `nav` translation namespace
 * so brand interpolation and locale switching work without re-running this function.
 */
function buildNavBase(): Omit<NavItem, 'label'>[] {
  return [
    { to: '/onboarding', icon: 'upload' },
    { to: '/profile', icon: 'user' },
    { to: '/dashboard', icon: 'users' },
  ];
}

export function Sidebar() {
  const t = useTranslations('nav');
  const pathname = usePathname();
  const { user, signOut, supportEnabled } = useAuth();
  const { mode } = useThemeMode();
  const [supportOpen, setSupportOpen] = useState(false);
  const orgInitials = (user?.org ?? 'TR').slice(0, 2).toUpperCase();
  // Brand + domain labels come from the aggregator config so the
  // sidebar adapts to whichever signalstack network the deployment is
  // bound to (blue / purple / yellow / ...) without code changes.
  const { data: cfg = DEFAULT_AGGREGATOR_CONFIG } = useAggregatorConfig();
  // Dashboard rollup feeds the participant-count badge. Domain follows
  // the aggregator's registered focus; falls back to the first domain
  // declared by the network when the profile is still resolving.
  const profileType = useProfileRaw().data?.type;
  // No 'seeker' fallback — until both profile + live network config have
  // loaded, `activeDomain` is undefined and useDashboard skips the
  // fetch (prevents a stale `?domain=seeker` request on cold mount).
  const activeDomain = profileType ?? cfg.domains[0]?.id;
  const { data: dashboard } = useDashboard(activeDomain ? { domain: activeDomain } : undefined);
  // Plan-C / by_domain dashboard shape: every served domain ships under
  // `by_domain[<id>]`; the badge mirrors the active aggregator's domain
  // rollup so the sidebar count stays in sync with /dashboard.
  const participantsBadge = activeDomain
    ? dashboard?.by_domain[activeDomain]?.rollup.total_items
    : undefined;

  // Resolve translated labels here so brand interpolation and locale switching
  // work correctly; buildNavBase() supplies the stable route/icon skeleton.
  const navLabels: Record<string, string> = {
    '/dashboard': t('my', { brand: cfg.brand.short_name }),
    '/onboarding': t('onboarding'),
    '/profile': t('profile'),
  };
  const nav: NavItem[] = buildNavBase().map((n) => ({
    ...n,
    label: navLabels[n.to] ?? n.to,
    ...(n.to === '/dashboard' && participantsBadge !== undefined
      ? { badge: participantsBadge }
      : {}),
  }));

  return (
    <aside className="w-[252px] shrink-0 bg-[var(--bd-card)] border-r border-[var(--bd-border)] flex flex-col h-screen sticky top-0">
      <div className="px-5 pt-6 pb-5">
        {cfg.brand.logo?.default ? (
          <Image
            src={
              mode === 'dark' && cfg.brand.logo?.light
                ? cfg.brand.logo.light
                : cfg.brand.logo.default
            }
            alt={cfg.brand.short_name}
            width={180}
            height={48}
            priority
            className="h-10 w-auto object-contain object-left"
          />
        ) : (
          <div className="flex items-center gap-3">
            <BlueDotsLogo size={40} />
            <div>
              <div className="font-display font-bold text-[17px] text-[var(--bd-fg)] leading-tight">
                {cfg.brand.short_name}
              </div>
              <div className="text-[12px] text-[var(--bd-fg-muted)] leading-tight mt-0.5">
                {t('portal_label')}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="px-3">
        <div className="px-3 pt-3 pb-2 text-[10.5px] uppercase tracking-[0.12em] font-semibold text-[var(--bd-fg-muted)] opacity-60">
          {t('overview')}
        </div>
        <nav className="flex flex-col gap-0.5">
          {nav.map((n) => {
            const Ic = I[n.icon];
            const isActive = pathname === n.to || pathname?.startsWith(`${n.to}/`);
            return (
              <Link
                key={n.to}
                href={n.to}
                className={cn(
                  'group flex items-center gap-3 px-3 py-2.5 rounded-[10px] text-[14px] font-medium transition-all',
                  isActive
                    ? 'nav-active'
                    : 'text-[var(--bd-fg-muted)] hover:bg-[var(--bd-border-soft)] hover:text-[var(--bd-fg)]',
                )}
              >
                <Ic size={18} stroke={isActive ? 2 : 1.7} />
                <span>{n.label}</span>
                {n.badge !== undefined && (
                  <span
                    className={cn(
                      'ml-auto text-[11px] font-semibold px-1.5 py-0.5 rounded-md',
                      isActive
                        ? 'bg-[var(--bd-card)] text-primary-600'
                        : 'bg-[var(--bd-border-soft)] text-[var(--bd-fg-muted)]',
                    )}
                  >
                    {n.badge}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
      </div>

      <div className="mt-auto">
        {supportEnabled && (
          <div className="px-3 pb-2">
            <Button
              kind="ghost"
              icon={<I.message size={16} />}
              onClick={() => setSupportOpen(true)}
              className="w-full justify-start"
            >
              {t('contact_support')}
            </Button>
          </div>
        )}

        <div className="p-3 shrink-0">
          <div className="rounded-[12px] bg-gradient-to-br from-[var(--bd-tint-primary)] to-[var(--bd-card)] border border-[var(--bd-border)] p-3 flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-[var(--bd-brand)] text-white flex items-center justify-center font-display font-bold text-[12px] shrink-0">
              {orgInitials}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-[var(--bd-fg)] truncate">
                {user?.org ?? 'TRRAIN'}
              </div>
              <div className="text-[11px] text-[var(--bd-fg-muted)] truncate">
                {t('aggregator_sublabel')}
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                void signOut();
              }}
              title={t('sign_out')}
              aria-label={t('sign_out')}
              className="w-7 h-7 rounded-md flex items-center justify-center text-[var(--bd-fg-muted)] hover:bg-[var(--bd-border-soft)] hover:text-rose-500 transition-colors shrink-0"
            >
              <I.signout size={15} />
            </button>
          </div>
        </div>
      </div>

      <SupportDialog open={supportOpen} onOpenChange={setSupportOpen} />
    </aside>
  );
}
