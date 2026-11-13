'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { I, type IconName } from '../../icons';
import { BlueDotsLogo } from '../ui/BlueDotsLogo';
import { useAuth, useCan } from '../../lib/auth-context';
import { useThemeMode } from '../../lib/theme-mode';
import { SupportDialog } from '../support/SupportDialog';
import { Button } from '../ui/Button';
import { useDashboard } from '../../hooks/useDashboard';
import { useProfileRaw } from '../../hooks/useProfile';
import {
  useAggregatorConfig,
  DEFAULT_AGGREGATOR_CONFIG,
  type AggregatorConfigPayload,
} from '../../hooks/useAggregatorConfig';
import { cn } from '../../lib/cn';
import { initialsOf } from '../../lib/initials';

/** One sidebar link. */
export interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  badge?: number;
  /** Active only on `to` itself, not below it (a home link). */
  exact?: boolean;
  /** Path whose subtree marks the link active, when it differs from `to`. */
  match?: string;
}

/** The account card at the foot of the sidebar. */
export interface SidebarAccount {
  /** First line, also the source of the two-letter badge. */
  title: string;
  subtitle: string;
  /**
   * Extra label/value rows shown in a pop-up above the card when it's
   * clicked (e.g. contact details). Omit to leave the card non-interactive,
   * as before — the sign-out button is unaffected either way.
   */
  details?: ReadonlyArray<{ label: string; value: string; icon?: IconName }>;
}

/** Whether `n` is the current page's link. */
function isNavActive(n: NavItem, pathname: string | null): boolean {
  if (n.exact) return pathname === n.to;
  const base = n.match ?? n.to;
  return pathname === base || Boolean(pathname?.startsWith(`${base}/`));
}

/**
 * Viewport width from which the fixed sidebar replaces the mobile menu bar
 * and drawer. Matches Tailwind's `lg` breakpoint.
 */
const DESKTOP_MEDIA_QUERY = '(min-width: 1024px)';

/** Elements the drawer's focus trap cycles through. */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Returns the route and icon structure for the side nav. The component
 * resolves labels from the `nav` translation namespace.
 */
function buildNavBase(): Omit<NavItem, 'label'>[] {
  return [
    { to: '/onboarding', icon: 'upload' },
    { to: '/profile', icon: 'user' },
    { to: '/dashboard', icon: 'users' },
  ];
}

/**
 * Brand logo, or the BlueDotsLogo and name fallback. `compact` is the smaller
 * variant for the mobile menu bar, without the sub-label.
 */
function BrandMark({
  cfg,
  mode,
  portalLabel,
  compact = false,
}: {
  cfg: AggregatorConfigPayload;
  mode: 'light' | 'dark';
  portalLabel: string;
  compact?: boolean;
}) {
  if (cfg.brand.logo?.default) {
    return (
      <Image
        src={
          mode === 'dark' && cfg.brand.logo?.light ? cfg.brand.logo.light : cfg.brand.logo.default
        }
        alt={cfg.brand.short_name}
        width={180}
        height={48}
        priority
        className={cn('w-auto max-w-full object-contain object-left', compact ? 'h-8' : 'h-10')}
      />
    );
  }
  return (
    <div className="flex items-center gap-3 min-w-0">
      <BlueDotsLogo size={compact ? 32 : 40} />
      <div className="min-w-0">
        <div className="font-display font-bold text-[17px] text-(--bd-fg) leading-tight truncate">
          {cfg.brand.short_name}
        </div>
        {!compact && (
          <div className="text-[12px] text-(--bd-fg-muted) leading-tight mt-0.5">{portalLabel}</div>
        )}
      </div>
    </div>
  );
}

interface SidebarPanelProps {
  brand: ReactNode;
  nav: NavItem[];
  account: SidebarAccount;
  pathname: string | null;
  /** Rendered beside the brand, such as the drawer's close button on mobile. */
  headerAction?: ReactNode;
  /** Called after a nav link is followed, so the drawer can close. */
  onNavigate?: () => void;
  onOpenSupport: () => void;
}

/**
 * Sidebar contents, used by both the desktop `<aside>` and the mobile drawer:
 * brand, nav links, the optional Contact-support entry, and the account card.
 */
function SidebarPanel({
  brand,
  nav,
  account,
  pathname,
  headerAction,
  onNavigate,
  onOpenSupport,
}: SidebarPanelProps) {
  const t = useTranslations('nav');
  const { signOut, supportEnabled } = useAuth();
  // An email title gives its local part's initials ("admin@x.org" → "AD").
  const initials = initialsOf(account.title.split('@')[0] ?? account.title);
  // The title (an email when there is no name) already shows in a detail row.
  const titleRepeated = account.details?.some((d) => d.value === account.title) ?? false;

  const [detailsOpen, setDetailsOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!detailsOpen) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (
        e instanceof KeyboardEvent
          ? e.key === 'Escape'
          : !accountRef.current?.contains(e.target as Node)
      ) {
        setDetailsOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [detailsOpen]);

  return (
    <>
      <div className="px-5 pt-6 pb-5 flex items-start gap-2">
        <div className="min-w-0 flex-1">{brand}</div>
        {headerAction}
      </div>

      <div className="px-3">
        <div className="px-3 pt-3 pb-2 text-[10.5px] uppercase tracking-[0.12em] font-semibold text-(--bd-fg-muted) opacity-60">
          {t('overview')}
        </div>
        <nav className="flex flex-col gap-0.5">
          {nav.map((n) => {
            const Ic = I[n.icon];
            const isActive = isNavActive(n, pathname);
            return (
              <Link
                key={n.to}
                href={n.to}
                {...(onNavigate ? { onClick: onNavigate } : {})}
                className={cn(
                  'group flex items-center gap-3 px-3 py-2.5 rounded-[10px] text-[14px] font-medium transition-all',
                  isActive
                    ? 'nav-active'
                    : 'text-(--bd-fg-muted) hover:bg-(--bd-border-soft) hover:text-(--bd-fg)',
                )}
              >
                <Ic size={18} stroke={isActive ? 2 : 1.7} />
                <span>{n.label}</span>
                {n.badge !== undefined && (
                  <span
                    className={cn(
                      'ml-auto text-[11px] font-semibold px-1.5 py-0.5 rounded-md',
                      isActive
                        ? 'bg-(--bd-card) text-primary-600'
                        : 'bg-(--bd-border-soft) text-(--bd-fg-muted)',
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
              onClick={onOpenSupport}
              className="w-full justify-start"
            >
              {t('contact_support')}
            </Button>
          </div>
        )}

        <div className="p-3 shrink-0 relative" ref={accountRef}>
          {account.details && account.details.length > 0 && detailsOpen && (
            <dialog
              open
              aria-label={account.title}
              className="absolute bottom-full left-3 right-3 mb-2 w-auto overflow-hidden rounded-[14px] border border-(--bd-border) bg-(--bd-card) p-0 text-inherit shadow-xl"
            >
              <div className="flex items-center gap-3 border-b border-(--bd-border-soft) bg-linear-to-br from-(--bd-tint-primary) to-(--bd-card) px-4 py-3.5">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-(--bd-brand) font-display text-[13px] font-bold text-white">
                  {initials}
                </div>
                <div className="min-w-0">
                  {titleRepeated ? (
                    <div className="wrap-break-word text-[14px] font-bold text-(--bd-fg)">
                      {account.subtitle}
                    </div>
                  ) : (
                    <>
                      <div className="wrap-break-word text-[14px] font-bold text-(--bd-fg)">
                        {account.title}
                      </div>
                      <div className="truncate text-[12px] text-(--bd-fg-muted)">
                        {account.subtitle}
                      </div>
                    </>
                  )}
                </div>
              </div>
              <dl className="flex flex-col gap-1 p-2">
                {account.details.map((d) => {
                  const Ic = d.icon ? I[d.icon] : null;
                  return (
                    <div key={d.label} className="flex items-center gap-3 rounded-[10px] px-2 py-2">
                      {Ic ? (
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-(--bd-border-soft) text-(--bd-fg-muted)">
                          <Ic size={15} />
                        </span>
                      ) : null}
                      <div className="min-w-0">
                        <dt className="text-[11px] font-semibold text-(--bd-fg-muted)">
                          {d.label}
                        </dt>
                        <dd className="wrap-break-word text-[13px] font-medium text-(--bd-fg)">
                          {d.value}
                        </dd>
                      </div>
                    </div>
                  );
                })}
              </dl>
            </dialog>
          )}
          <div className="rounded-[12px] bg-linear-to-br from-(--bd-tint-primary) to-(--bd-card) border border-(--bd-border) p-3 flex items-center gap-2.5">
            {account.details && account.details.length > 0 ? (
              <button
                type="button"
                onClick={() => setDetailsOpen((v) => !v)}
                aria-expanded={detailsOpen}
                aria-haspopup="dialog"
                className="flex items-center gap-2.5 min-w-0 flex-1 text-left"
              >
                <div className="w-8 h-8 rounded-lg bg-(--bd-brand) text-white flex items-center justify-center font-display font-bold text-[12px] shrink-0">
                  {initials}
                </div>
                <div className="min-w-0 flex-1">
                  <div
                    className="text-[13px] font-semibold text-(--bd-fg) truncate"
                    title={account.title}
                  >
                    {account.title}
                  </div>
                  <div className="text-[11px] text-(--bd-fg-muted) truncate">
                    {account.subtitle}
                  </div>
                </div>
              </button>
            ) : (
              <>
                <div className="w-8 h-8 rounded-lg bg-(--bd-brand) text-white flex items-center justify-center font-display font-bold text-[12px] shrink-0">
                  {initials}
                </div>
                <div className="min-w-0 flex-1">
                  <div
                    className="text-[13px] font-semibold text-(--bd-fg) truncate"
                    title={account.title}
                  >
                    {account.title}
                  </div>
                  <div className="text-[11px] text-(--bd-fg-muted) truncate">
                    {account.subtitle}
                  </div>
                </div>
              </>
            )}
            <button
              type="button"
              onClick={() => {
                void signOut();
              }}
              title={t('sign_out')}
              aria-label={t('sign_out')}
              className="w-7 h-7 rounded-md flex items-center justify-center text-(--bd-fg-muted) hover:bg-(--bd-border-soft) hover:text-rose-500 transition-colors shrink-0"
            >
              <I.signout size={15} />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

/** What {@link AppSidebar} shows. */
export interface AppSidebarProps {
  nav: NavItem[];
  /** Under the brand name when the brand has no logo, e.g. "Aggregator Portal". */
  portalLabel: string;
  account: SidebarAccount;
}

/**
 * Navigation shell shared by the coordinator portal and the organisation
 * console: brand, links, Contact support (when enabled) and the account card.
 * Reads `useAuth()`, so it must sit inside an `AuthProvider`.
 *
 * From `lg` up this is the fixed left sidebar. Below `lg` a slim bar (menu
 * button and brand) opens the same contents as a slide-in drawer. The drawer
 * closes on Escape, backdrop tap, link click, or resize to desktop width.
 * While open it locks page scroll and keeps focus inside.
 *
 * @param props - The links, the label under the brand and the account card.
 */
export function AppSidebar({ nav, portalLabel, account }: AppSidebarProps) {
  const t = useTranslations('nav');
  const pathname = usePathname();
  // `mode` picks the dark-theme logo variant; the toggle lives in Topbar.
  const { mode } = useThemeMode();
  const [supportOpen, setSupportOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const drawerId = useId();
  // Brand comes from the aggregator config.
  const { data: cfg = DEFAULT_AGGREGATOR_CONFIG } = useAggregatorConfig();

  // While the drawer is open: lock page scroll, move focus in, trap Tab,
  // close on Escape, and close if the viewport grows to desktop width. Focus
  // returns to the menu button on close.
  useEffect(() => {
    if (!menuOpen) return;
    const menuButton = menuButtonRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButtonRef.current?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        return;
      }
      if (e.key !== 'Tab' || !drawerRef.current) return;
      const focusable = Array.from(
        drawerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);

    const desktop =
      typeof window.matchMedia === 'function' ? window.matchMedia(DESKTOP_MEDIA_QUERY) : null;
    const onViewportChange = (e: MediaQueryListEvent) => {
      if (e.matches) setMenuOpen(false);
    };
    desktop?.addEventListener('change', onViewportChange);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
      desktop?.removeEventListener('change', onViewportChange);
      menuButton?.focus();
    };
  }, [menuOpen]);

  const closeMenu = () => setMenuOpen(false);
  const openSupport = () => {
    setMenuOpen(false);
    setSupportOpen(true);
  };

  return (
    <>
      {/* Mobile menu bar, shown below `lg`. */}
      <header className="lg:hidden sticky top-0 z-40 flex items-center gap-2 h-14 px-3 bg-(--bd-card) border-b border-(--bd-border)">
        <button
          ref={menuButtonRef}
          type="button"
          onClick={() => setMenuOpen(true)}
          aria-label={t('open_menu')}
          aria-expanded={menuOpen}
          aria-controls={drawerId}
          className="w-10 h-10 rounded-[10px] flex items-center justify-center text-(--bd-fg) hover:bg-(--bd-border-soft) transition-colors shrink-0"
        >
          <I.menu size={20} />
        </button>
        <div className="min-w-0 flex-1">
          <BrandMark cfg={cfg} mode={mode} portalLabel={portalLabel} compact />
        </div>
      </header>

      <aside className="hidden lg:flex w-[252px] shrink-0 bg-(--bd-card) border-r border-(--bd-border) flex-col h-screen sticky top-0">
        <SidebarPanel
          brand={<BrandMark cfg={cfg} mode={mode} portalLabel={portalLabel} />}
          nav={nav}
          account={account}
          pathname={pathname}
          onOpenSupport={openSupport}
        />
      </aside>

      {menuOpen && (
        <div className="lg:hidden fixed inset-0 z-50">
          <div
            className="absolute inset-0 bg-black/50"
            aria-hidden="true"
            data-testid="nav-drawer-backdrop"
            onClick={closeMenu}
          />
          <div
            ref={drawerRef}
            id={drawerId}
            role="dialog"
            aria-modal="true"
            aria-label={t('menu_label')}
            className="absolute inset-y-0 left-0 w-[252px] max-w-[85vw] bg-(--bd-card) border-r border-(--bd-border) flex flex-col overflow-y-auto shadow-xl"
          >
            <SidebarPanel
              brand={<BrandMark cfg={cfg} mode={mode} portalLabel={portalLabel} />}
              nav={nav}
              account={account}
              pathname={pathname}
              onNavigate={closeMenu}
              onOpenSupport={openSupport}
              headerAction={
                <button
                  ref={closeButtonRef}
                  type="button"
                  onClick={closeMenu}
                  aria-label={t('close_menu')}
                  className="w-9 h-9 -mt-1 -mr-2 rounded-[10px] flex items-center justify-center text-(--bd-fg-muted) hover:text-(--bd-fg) hover:bg-(--bd-border-soft) transition-colors shrink-0"
                >
                  <I.x size={18} />
                </button>
              }
            />
          </div>
        </div>
      )}

      <SupportDialog open={supportOpen} onOpenChange={setSupportOpen} />
    </>
  );
}

/**
 * The coordinator portal's sidebar: Onboarding (with `profiles.onboard`),
 * Profile and the participant dashboard with its count badge.
 */
export function Sidebar() {
  const t = useTranslations('nav');
  const { user } = useAuth();
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

  const can = useCan();
  // Resolve translated labels here so brand interpolation and locale switching
  // work correctly; buildNavBase() supplies the stable route/icon skeleton.
  const navLabels: Record<string, string> = {
    '/dashboard': t('my', { brand: cfg.brand.short_name }),
    '/onboarding': t('onboarding'),
    '/profile': t('profile'),
  };
  // RBAC: onboarding needs `profiles.onboard`; the API also checks it.
  const nav: NavItem[] = buildNavBase()
    .filter((n) => n.to !== '/onboarding' || can('profiles.onboard'))
    .map((n) => ({
      ...n,
      label: navLabels[n.to] ?? n.to,
      ...(n.to === '/dashboard' && participantsBadge !== undefined
        ? { badge: participantsBadge }
        : {}),
    }));

  return (
    <AppSidebar
      nav={nav}
      portalLabel={t('portal_label')}
      account={{ title: user?.org ?? 'TRRAIN', subtitle: t('aggregator_sublabel') }}
    />
  );
}
