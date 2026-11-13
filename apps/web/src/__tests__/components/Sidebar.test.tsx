/**
 * Unit tests for Sidebar.
 *
 * Covers: nav item rendering + active-route highlighting, the participants
 * badge sourced from the dashboard rollup for the active domain, the
 * brand-logo vs BlueDotsLogo fallback (and its dark/light swap), the
 * conditional "Contact support" entry gated by `supportEnabled`, and the
 * sign-out control, plus the mobile menu bar + navigation drawer (#793): open /
 * close paths, focus handling, scroll lock and the Tab focus trap. All data hooks (`useAuth`, `useThemeMode`,
 * `useAggregatorConfig`, `useDashboard`, `useProfileRaw`) are mocked since
 * they belong to `lib/`/`hooks/`, owned by other concurrent work — only
 * Sidebar's own composition logic is under test here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, within } from '@testing-library/react';

const {
  useAuth,
  useCan,
  useThemeMode,
  useAggregatorConfig,
  useDashboard,
  useProfileRaw,
  usePathname,
} = vi.hoisted(() => ({
  useAuth: vi.fn(),
  useCan: vi.fn(),
  useThemeMode: vi.fn(),
  useAggregatorConfig: vi.fn(),
  useDashboard: vi.fn(),
  useProfileRaw: vi.fn(),
  usePathname: vi.fn(),
}));

vi.mock('@/lib/auth-context', () => ({ useAuth, useCan }));
vi.mock('@/lib/theme-mode', () => ({ useThemeMode }));
vi.mock('@/hooks/useAggregatorConfig', () => ({
  useAggregatorConfig,
  DEFAULT_AGGREGATOR_CONFIG: {
    aggregator: { name: 'Aggregator' },
    brand: { short_name: 'Blue Dots', long_name: 'Blue Dots Portal', url_slug: 'dashboard' },
    network: { id: 'blue_dot' },
    domains: [
      { id: 'seeker', label: 'Seekers', plural_label: 'Seekers', item_type: 'profile_1.0' },
    ],
  },
}));
vi.mock('@/hooks/useDashboard', () => ({ useDashboard }));
vi.mock('@/hooks/useProfile', () => ({ useProfileRaw }));
vi.mock('next/navigation', () => ({ usePathname }));
vi.mock('next/image', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: (props: any) => <img {...props} alt={props.alt} />,
}));
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, vars?: Record<string, string>) => {
    const map: Record<string, string> = {
      my: `My ${vars?.brand ?? ''}`,
      onboarding: 'Onboarding',
      profile: 'Profile',
      overview: 'Overview',
      portal_label: 'Aggregator Portal',
      sign_out: 'Sign Out',
      aggregator_sublabel: 'Aggregator',
      contact_support: 'Contact support',
      open_menu: 'Open menu',
      close_menu: 'Close menu',
      menu_label: 'Main navigation',
    };
    return map[key] ?? key;
  },
}));

import { AppSidebar, Sidebar } from '@/components/shell/Sidebar';

function mockDefaults() {
  usePathname.mockReturnValue('/onboarding');
  useCan.mockReturnValue(() => true);
  useAuth.mockReturnValue({
    user: { id: 'u1', org: 'Acme Org', name: 'Acme', email: 'a@a.com', phone: '' },
    signOut: vi.fn(),
    supportEnabled: false,
  });
  useThemeMode.mockReturnValue({ mode: 'light' });
  useAggregatorConfig.mockReturnValue({ data: undefined });
  useProfileRaw.mockReturnValue({ data: undefined });
  useDashboard.mockReturnValue({ data: undefined });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDefaults();
});

describe('<Sidebar />', () => {
  it('renders the three nav items with their labels', () => {
    render(<Sidebar />);
    expect(screen.getByRole('link', { name: /Onboarding/ })).toHaveAttribute('href', '/onboarding');
    expect(screen.getByRole('link', { name: /Profile/ })).toHaveAttribute('href', '/profile');
    expect(screen.getByRole('link', { name: /My/ })).toHaveAttribute('href', '/dashboard');
  });

  it('marks the current route active via the nav-active class', () => {
    usePathname.mockReturnValue('/onboarding');
    render(<Sidebar />);
    expect(screen.getByRole('link', { name: /Onboarding/ })).toHaveClass('nav-active');
    expect(screen.getByRole('link', { name: /Profile/ })).not.toHaveClass('nav-active');
  });

  it('treats a nested path as active via the startsWith check', () => {
    usePathname.mockReturnValue('/profile/edit');
    render(<Sidebar />);
    expect(screen.getByRole('link', { name: /Profile/ })).toHaveClass('nav-active');
  });

  it('shows the participants badge on the dashboard link when a rollup total is available', () => {
    useProfileRaw.mockReturnValue({ data: { type: 'seeker' } });
    useDashboard.mockReturnValue({
      data: { by_domain: { seeker: { rollup: { total_items: 42 } } } },
    });
    render(<Sidebar />);
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('omits the badge when no rollup total is available yet', () => {
    render(<Sidebar />);
    expect(screen.queryByText(/^\d+$/)).toBeNull();
  });

  // The brand renders twice — desktop <aside> (complementary) and the mobile
  // menu bar <header> (banner) — so brand assertions are scoped to one landmark.
  it('renders the fallback BlueDotsLogo + short name when no brand logo is configured', () => {
    render(<Sidebar />);
    const aside = within(screen.getByRole('complementary'));
    expect(aside.getByText('Blue Dots')).toBeInTheDocument();
    expect(aside.getByText('Aggregator Portal')).toBeInTheDocument();
  });

  it('renders a compact brand (no portal sub-label) in the mobile menu bar', () => {
    render(<Sidebar />);
    const header = within(screen.getByRole('banner'));
    expect(header.getByText('Blue Dots')).toBeInTheDocument();
    expect(header.queryByText('Aggregator Portal')).toBeNull();
  });

  it('renders the configured brand logo image, swapping to the dark variant in dark mode', () => {
    useAggregatorConfig.mockReturnValue({
      data: {
        aggregator: { name: 'Aggregator' },
        brand: {
          short_name: 'Purple Dots',
          long_name: 'Purple Dots Portal',
          url_slug: 'dashboard',
          logo: { default: '/logo-light.png', light: '/logo-dark.png' },
        },
        network: { id: 'purple_dot' },
        domains: [],
      },
    });
    useThemeMode.mockReturnValue({ mode: 'dark' });
    render(<Sidebar />);
    const img = within(screen.getByRole('complementary')).getByRole('img', { name: 'Purple Dots' });
    expect(img).toHaveAttribute('src', '/logo-dark.png');
    expect(
      within(screen.getByRole('banner')).getByRole('img', { name: 'Purple Dots' }),
    ).toHaveAttribute('src', '/logo-dark.png');
  });

  it('uses the default logo variant in light mode even when a dark variant is configured', () => {
    useAggregatorConfig.mockReturnValue({
      data: {
        aggregator: { name: 'Aggregator' },
        brand: {
          short_name: 'Purple Dots',
          long_name: 'Purple Dots Portal',
          url_slug: 'dashboard',
          logo: { default: '/logo-light.png', light: '/logo-dark.png' },
        },
        network: { id: 'purple_dot' },
        domains: [],
      },
    });
    useThemeMode.mockReturnValue({ mode: 'light' });
    render(<Sidebar />);
    const img = within(screen.getByRole('complementary')).getByRole('img', { name: 'Purple Dots' });
    expect(img).toHaveAttribute('src', '/logo-light.png');
  });

  it('omits the participants badge when there is no active domain at all', () => {
    // No profile type resolved yet AND the aggregator config declares no
    // domains — `activeDomain` stays undefined, so the badge is never computed.
    useAggregatorConfig.mockReturnValue({
      data: {
        aggregator: { name: 'Aggregator' },
        brand: { short_name: 'Blue Dots', long_name: 'Blue Dots Portal', url_slug: 'dashboard' },
        network: { id: 'blue_dot' },
        domains: [],
      },
    });
    render(<Sidebar />);
    expect(screen.queryByText(/^\d+$/)).toBeNull();
  });

  it('applies the active-tone badge styling when the dashboard link itself is the current route', () => {
    usePathname.mockReturnValue('/dashboard');
    useProfileRaw.mockReturnValue({ data: { type: 'seeker' } });
    useDashboard.mockReturnValue({
      data: { by_domain: { seeker: { rollup: { total_items: 7 } } } },
    });
    render(<Sidebar />);
    const badge = screen.getByText('7');
    expect(badge).toHaveClass('text-primary-600');
  });

  it('renders the org initials and org name in the footer card', () => {
    render(<Sidebar />);
    expect(screen.getByText('AO')).toBeInTheDocument();
    expect(screen.getByText('Acme Org')).toBeInTheDocument();
  });

  it('falls back to TRRAIN when there is no user org', () => {
    useAuth.mockReturnValue({ user: null, signOut: vi.fn(), supportEnabled: false });
    render(<Sidebar />);
    expect(screen.getByText('TRRAIN')).toBeInTheDocument();
  });

  it('calls signOut when the sign-out button is clicked', () => {
    const signOut = vi.fn().mockResolvedValue(undefined);
    useAuth.mockReturnValue({
      user: { id: 'u1', org: 'Acme Org' },
      signOut,
      supportEnabled: false,
    });
    render(<Sidebar />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign Out' }));
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('hides the Contact support entry when supportEnabled is false', () => {
    render(<Sidebar />);
    expect(screen.queryByRole('button', { name: 'Contact support' })).toBeNull();
  });

  it('shows the Contact support entry and opens the dialog when supportEnabled is true', () => {
    useAuth.mockReturnValue({
      user: { id: 'u1', org: 'Acme Org' },
      signOut: vi.fn(),
      supportEnabled: true,
    });
    render(<Sidebar />);
    const supportBtn = screen.getByRole('button', { name: 'Contact support' });
    expect(supportBtn).toBeInTheDocument();
    fireEvent.click(supportBtn);
    // SupportDialog mounts its dialog content once opened.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('<Sidebar /> mobile navigation drawer', () => {
  function openDrawer() {
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    return screen.getByRole('dialog', { name: 'Main navigation' });
  }

  afterEach(() => {
    document.body.style.overflow = '';
  });

  it('renders the menu bar with a collapsed menu button and no drawer', () => {
    render(<Sidebar />);
    expect(screen.getByRole('button', { name: 'Open menu' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.queryByRole('dialog', { name: 'Main navigation' })).toBeNull();
  });

  it('opens the drawer with the nav links, locks scroll and focuses the close button', () => {
    render(<Sidebar />);
    const drawer = openDrawer();
    const menuBtn = screen.getByRole('button', { name: 'Open menu' });
    expect(menuBtn).toHaveAttribute('aria-expanded', 'true');
    expect(menuBtn).toHaveAttribute('aria-controls', drawer.id);
    expect(within(drawer).getByRole('link', { name: /Onboarding/ })).toHaveAttribute(
      'href',
      '/onboarding',
    );
    expect(document.body.style.overflow).toBe('hidden');
    expect(within(drawer).getByRole('button', { name: 'Close menu' })).toHaveFocus();
  });

  it('closes on Escape, restores scroll and returns focus to the menu button', () => {
    render(<Sidebar />);
    openDrawer();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Main navigation' })).toBeNull();
    expect(document.body.style.overflow).toBe('');
    expect(screen.getByRole('button', { name: 'Open menu' })).toHaveFocus();
  });

  it('closes when the close button is clicked', () => {
    render(<Sidebar />);
    const drawer = openDrawer();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close menu' }));
    expect(screen.queryByRole('dialog', { name: 'Main navigation' })).toBeNull();
  });

  it('closes when the backdrop is tapped', () => {
    render(<Sidebar />);
    openDrawer();
    fireEvent.click(screen.getByTestId('nav-drawer-backdrop'));
    expect(screen.queryByRole('dialog', { name: 'Main navigation' })).toBeNull();
  });

  it('closes after a nav link inside the drawer is followed', () => {
    render(<Sidebar />);
    const drawer = openDrawer();
    fireEvent.click(within(drawer).getByRole('link', { name: /Profile/ }));
    expect(screen.queryByRole('dialog', { name: 'Main navigation' })).toBeNull();
  });

  it('wraps Tab focus between the first and last focusable drawer elements', () => {
    render(<Sidebar />);
    const drawer = openDrawer();
    const closeBtn = within(drawer).getByRole('button', { name: 'Close menu' });
    const signOutBtn = within(drawer).getByRole('button', { name: 'Sign Out' });

    signOutBtn.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(closeBtn).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(signOutBtn).toHaveFocus();
  });

  it('closes the drawer and opens the support dialog from the drawer entry', () => {
    useAuth.mockReturnValue({
      user: { id: 'u1', org: 'Acme Org' },
      signOut: vi.fn(),
      supportEnabled: true,
    });
    render(<Sidebar />);
    const drawer = openDrawer();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Contact support' }));
    expect(screen.queryByRole('dialog', { name: 'Main navigation' })).toBeNull();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('closes the drawer when the viewport grows to desktop width', () => {
    let listener: ((e: { matches: boolean }) => void) | undefined;
    const original = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: (_: string, cb: (e: { matches: boolean }) => void) => {
        listener = cb;
      },
      removeEventListener: vi.fn(),
    }) as unknown as typeof window.matchMedia;
    try {
      render(<Sidebar />);
      openDrawer();
      act(() => listener?.({ matches: true }));
      expect(screen.queryByRole('dialog', { name: 'Main navigation' })).toBeNull();
    } finally {
      window.matchMedia = original;
    }
  });

  it('hides Onboarding without profiles.onboard (RBAC)', () => {
    mockDefaults();
    useCan.mockReturnValue((c: string) => c !== 'profiles.onboard');
    render(<Sidebar />);
    expect(screen.queryAllByText('Onboarding')).toHaveLength(0);
  });
});

describe('<AppSidebar /> account card', () => {
  const renderCard = (account: Parameters<typeof AppSidebar>[0]['account']) =>
    render(<AppSidebar nav={[]} portalLabel="Console" account={account} />);

  it('opens with the email once when the title is the email', () => {
    renderCard({
      title: 'admin@net.org',
      subtitle: 'Network admin',
      details: [{ label: 'Email', value: 'admin@net.org', icon: 'mail' }],
    });
    fireEvent.click(screen.getAllByRole('button', { name: /admin@net\.org/ })[0]!);
    const popup = screen.getByRole('dialog');
    expect(within(popup).getAllByText('admin@net.org')).toHaveLength(1);
    expect(within(popup).getByText('Network admin')).toBeInTheDocument();
    expect(within(popup).getByText('AD')).toBeInTheDocument();
  });

  it('keeps the name and the role in the header when there is a name', () => {
    renderCard({
      title: 'Asha Rao',
      subtitle: 'Organisation owner',
      details: [{ label: 'Email', value: 'asha@a.org', icon: 'mail' }],
    });
    fireEvent.click(screen.getAllByRole('button', { name: /Asha Rao/ })[0]!);
    const popup = screen.getByRole('dialog');
    expect(within(popup).getByText('Asha Rao')).toBeInTheDocument();
    expect(within(popup).getByText('Organisation owner')).toBeInTheDocument();
    expect(within(popup).getByText('asha@a.org')).toBeInTheDocument();
  });
});
