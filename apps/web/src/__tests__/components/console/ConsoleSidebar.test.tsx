/**
 * Unit tests for the console sidebar: the links each actor gets, which link is
 * active, and the account card, in the shell shared with the coordinator
 * portal. Hooks the shared shell reads are mocked, as in `Sidebar.test.tsx`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';

const { useAuth, useThemeMode, useAggregatorConfig, usePathname } = vi.hoisted(() => ({
  useAuth: vi.fn(),
  useThemeMode: vi.fn(),
  useAggregatorConfig: vi.fn(),
  usePathname: vi.fn(),
}));

vi.mock('@/lib/auth-context', () => ({ useAuth, useCan: () => () => true }));
vi.mock('@/lib/theme-mode', () => ({ useThemeMode }));
vi.mock('@/hooks/useAggregatorConfig', () => ({
  useAggregatorConfig,
  DEFAULT_AGGREGATOR_CONFIG: {
    aggregator: { name: 'Aggregator' },
    brand: { short_name: 'Blue Dots', long_name: 'Blue Dots Portal', url_slug: 'dashboard' },
    network: { id: 'blue_dot' },
    domains: [],
  },
}));
vi.mock('@/hooks/useDashboard', () => ({ useDashboard: () => ({ data: undefined }) }));
vi.mock('@/hooks/useProfile', () => ({ useProfileRaw: () => ({ data: undefined }) }));
vi.mock('next/navigation', () => ({ usePathname }));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));

import { ConsoleSidebar } from '@/components/console/ConsoleSidebar';

const account = { title: 'Asha Rao', subtitle: 'nav.network_admin' };

/** The desktop sidebar (the mobile drawer is closed). */
const aside = () => screen.getByRole('complementary');

beforeEach(() => {
  vi.clearAllMocks();
  usePathname.mockReturnValue('/console');
  useAuth.mockReturnValue({ signOut: vi.fn(), supportEnabled: false });
  useThemeMode.mockReturnValue({ mode: 'light' });
  useAggregatorConfig.mockReturnValue({ data: undefined });
});

describe('<ConsoleSidebar />', () => {
  it('gives the network admin every console link, with the brand and portal label', () => {
    render(<ConsoleSidebar canViewAccess account={account} />);
    const links = within(aside())
      .getAllByRole('link')
      .map((a) => [a.textContent, a.getAttribute('href')]);
    expect(links).toEqual([
      ['nav.organisations', '/console/orgs'],
      ['nav.coordinators', '/console/coordinators'],
      ['nav.access', '/console/access/roles'],
    ]);
    expect(within(aside()).getByText('Blue Dots')).toBeInTheDocument();
    expect(within(aside()).getByText('nav.portal_label')).toBeInTheDocument();
  });

  it('gives every admin Organisations; leaves out roles and, without org.manage, coordinators', () => {
    render(<ConsoleSidebar canManage={false} account={account} />);
    const hrefs = within(aside())
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/console/orgs']);
  });

  it('lists Organisations first and names the home link Coordinators when it lists them', () => {
    render(<ConsoleSidebar canManage={false} homeIsCoordinators account={account} />);
    const links = within(aside()).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/console/orgs', '/console']);
    expect(links[1]).toHaveAccessibleName('nav.coordinators');
  });

  it('marks the home link active only on /console itself', () => {
    usePathname.mockReturnValue('/console/orgs/123');
    render(<ConsoleSidebar canManage={false} homeIsCoordinators account={account} />);
    expect(within(aside()).getByRole('link', { name: 'nav.coordinators' })).not.toHaveClass(
      'nav-active',
    );
    expect(within(aside()).getByRole('link', { name: 'nav.organisations' })).toHaveClass(
      'nav-active',
    );
  });

  it('keeps the roles and permissions link active on the permissions table', () => {
    usePathname.mockReturnValue('/console/access/permissions');
    render(<ConsoleSidebar canViewAccess account={account} />);
    expect(within(aside()).getByRole('link', { name: 'nav.access' })).toHaveClass('nav-active');
  });

  it('shows the account card with the role, and sign-out, but no contact support', () => {
    render(<ConsoleSidebar account={account} />);
    expect(within(aside()).getByText('Asha Rao')).toBeInTheDocument();
    expect(within(aside()).getByText('AR')).toBeInTheDocument();
    expect(within(aside()).getByText('nav.network_admin')).toBeInTheDocument();
    expect(within(aside()).getByRole('button', { name: 'sign_out' })).toBeInTheDocument();
    expect(within(aside()).queryByText('contact_support')).toBeNull();
  });

  it('has no account-details pop-up, and the card is plain text, without `details`', () => {
    render(<ConsoleSidebar account={account} />);
    expect(within(aside()).queryByRole('button', { name: /Asha Rao/ })).toBeNull();
  });

  it('opens the account-details pop-up on click, independently of sign-out, and replaces the old My account page', () => {
    const signOut = vi.fn();
    useAuth.mockReturnValue({ signOut, supportEnabled: false });
    const withDetails = {
      ...account,
      details: [{ label: 'Email', value: 'asha@example.org' }],
    };
    render(<ConsoleSidebar account={withDetails} />);
    const toggle = within(aside()).getByRole('button', { name: /Asha Rao/ });

    expect(screen.queryByText('asha@example.org')).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText('Email')).toBeInTheDocument();
    expect(screen.getByText('asha@example.org')).toBeInTheDocument();

    fireEvent.click(within(aside()).getByRole('button', { name: 'sign_out' }));
    expect(signOut).toHaveBeenCalledOnce();
    expect(screen.getByText('asha@example.org')).toBeInTheDocument(); // sign-out didn't close it

    fireEvent.click(toggle);
    expect(screen.queryByText('asha@example.org')).toBeNull();
  });

  it('never offers Invite from the sidebar: it lives on the Coordinators page instead (#873)', () => {
    render(<ConsoleSidebar canManage account={account} />);
    const hrefs = within(aside())
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/console/coordinators');
    expect(hrefs).not.toContain('/console/invite');
  });
});
