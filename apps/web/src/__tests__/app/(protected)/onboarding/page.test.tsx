/**
 * Tests for the Onboarding landing page (`app/(protected)/onboarding/page.tsx`).
 *
 * Covers the two summary cards (Bulk Upload / Registration Link), their
 * derived metrics (totals, active/passed counts, "last upload/link" relative
 * time formatting), loading/empty states, and the CTA navigation buttons.
 * Child bodies (`RecentUploadsBody`, `YourLinksBody`, `OnboardingMetrics`) and
 * `Topbar` are stubbed so this file exercises only `page.tsx`'s own
 * aggregation logic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import messages from '@/i18n/messages/en.json';

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock('@/components/shell/Topbar', () => ({
  Topbar: ({ title, subtitle, right }: { title: string; subtitle?: string; right?: ReactNode }) => (
    <div>
      <h1>{title}</h1>
      {subtitle && <p>{subtitle}</p>}
      {right}
    </div>
  ),
}));

vi.mock('@/app/(protected)/onboarding/_components/CSVUpload', () => ({
  RecentUploadsBody: () => <div data-testid="recent-uploads-body" />,
}));

vi.mock('@/app/(protected)/onboarding/_components/RegistrationLinksSection', () => ({
  YourLinksBody: () => <div data-testid="your-links-body" />,
}));

vi.mock('@/app/(protected)/onboarding/_components/OnboardingMetrics', () => ({
  OnboardingMetrics: () => <div data-testid="onboarding-metrics" />,
}));

const { useRecentBulkUploads, useRegistrationLinks } = vi.hoisted(() => ({
  useRecentBulkUploads: vi.fn(),
  useRegistrationLinks: vi.fn(),
}));
vi.mock('@/hooks/useOnboarding', () => ({
  useRecentBulkUploads: (...args: unknown[]) => useRecentBulkUploads(...args),
  useRegistrationLinks: (...args: unknown[]) => useRegistrationLinks(...args),
}));

const { useProfileRaw } = vi.hoisted(() => ({ useProfileRaw: vi.fn() }));
vi.mock('@/hooks/useProfile', () => ({
  useProfileRaw: () => useProfileRaw(),
}));

const cfg = {
  domains: [
    { id: 'seeker', label: 'Seeker', plural_label: 'Seekers' },
    { id: 'provider', label: 'Provider', plural_label: 'Providers' },
  ],
};
const { useAggregatorConfig } = vi.hoisted(() => ({ useAggregatorConfig: vi.fn() }));
vi.mock('@/hooks/useAggregatorConfig', () => ({
  useAggregatorConfig: () => useAggregatorConfig(),
  DEFAULT_AGGREGATOR_CONFIG: {
    domains: [{ id: 'seeker', label: 'Seeker', plural_label: 'Seekers' }],
  },
}));

import OnboardingPage from '@/app/(protected)/onboarding/page';

function renderPage() {
  return render(
    <NextIntlClientProvider locale="en" messages={{ onboarding: messages.onboarding }}>
      <OnboardingPage />
    </NextIntlClientProvider>,
  );
}

describe('<OnboardingPage />', () => {
  beforeEach(() => {
    pushMock.mockClear();
    useAggregatorConfig.mockReturnValue({ data: cfg });
    useProfileRaw.mockReturnValue({ data: { type: 'seeker' } });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders the page title/subtitle and both summary cards with computed metrics', () => {
    useRecentBulkUploads.mockReturnValue({
      data: {
        items: [
          { total_rows: 10, passed: 7, failed: 1, created_at: new Date().toISOString() },
          { total_rows: 6, passed: 2, failed: 0, created_at: new Date(0).toISOString() },
        ],
      },
      isLoading: false,
    });
    useRegistrationLinks.mockReturnValue({
      data: [
        { status: 'live', metrics: { total: 12, passed: 5 }, created_at: new Date().toISOString() },
        { status: 'live', metrics: { total: 8, passed: 6 }, created_at: new Date(0).toISOString() },
        {
          status: 'draft',
          metrics: { total: 0, passed: 0 },
          created_at: new Date(0).toISOString(),
        },
      ],
      isLoading: false,
    });

    renderPage();

    expect(screen.getByText('Onboarding')).toBeInTheDocument();
    // Bulk upload metrics: 2 uploads, 16 rows, 9 passed, 1 failed.
    // Registration link metrics: 3 links, 2 active, 20 registrations, 11 verified.
    // "2" matches both the bulk-uploads count and the active-links count.
    expect(screen.getAllByText('2')).toHaveLength(2);
    expect(screen.getByText('16')).toBeInTheDocument();
    expect(screen.getByText('9')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('20')).toBeInTheDocument();
    expect(screen.getByText('11')).toBeInTheDocument();
    expect(screen.getByTestId('onboarding-metrics')).toBeInTheDocument();
    expect(screen.getByTestId('recent-uploads-body')).toBeInTheDocument();
    expect(screen.getByTestId('your-links-body')).toBeInTheDocument();
  });

  it('shows loading footnotes and placeholder metric values while queries are in flight', () => {
    useRecentBulkUploads.mockReturnValue({ data: undefined, isLoading: true });
    useRegistrationLinks.mockReturnValue({ data: undefined, isLoading: true });

    renderPage();

    // Both cards' footnote reuses the same "Loading…" copy.
    expect(screen.getAllByText('Loading…')).toHaveLength(2);
    // "…" is the placeholder for every metric tile (8 tiles total: 4 per card).
    expect(screen.getAllByText('…')).toHaveLength(8);
  });

  it('shows "no uploads/links yet" footnotes when queries resolve empty', () => {
    useRecentBulkUploads.mockReturnValue({ data: { items: [] }, isLoading: false });
    useRegistrationLinks.mockReturnValue({ data: [], isLoading: false });

    renderPage();

    expect(screen.getByText('No uploads yet')).toBeInTheDocument();
    expect(screen.getByText('No links yet')).toBeInTheDocument();
  });

  it('formats the "last upload" footnote using seconds/minutes/hours/days-ago buckets', () => {
    const hoursAgo = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    useRecentBulkUploads.mockReturnValue({
      data: { items: [{ total_rows: 1, passed: 1, failed: 0, created_at: hoursAgo }] },
      isLoading: false,
    });
    useRegistrationLinks.mockReturnValue({ data: [], isLoading: false });

    renderPage();

    expect(screen.getByText(/Last upload 3h ago/)).toBeInTheDocument();
  });

  it('formats the "last link" footnote using the days-ago bucket', () => {
    const daysAgo = new Date(Date.now() - 2 * 86400 * 1000).toISOString();
    useRecentBulkUploads.mockReturnValue({ data: { items: [] }, isLoading: false });
    useRegistrationLinks.mockReturnValue({
      data: [{ status: 'live', metrics: { total: 1, passed: 1 }, created_at: daysAgo }],
      isLoading: false,
    });

    renderPage();

    expect(screen.getByText(/Last link 2d ago/)).toBeInTheDocument();
  });

  it('falls back to the aggregator config default domain when the profile has not loaded yet', () => {
    useProfileRaw.mockReturnValue({ data: undefined });
    useRecentBulkUploads.mockReturnValue({ data: { items: [] }, isLoading: false });
    useRegistrationLinks.mockReturnValue({ data: [], isLoading: false });

    renderPage();

    expect(useRegistrationLinks).toHaveBeenCalledWith('seeker');
  });

  it('navigates to the bulk-uploads and links sub-pages on CTA click', async () => {
    const user = userEvent.setup();
    useRecentBulkUploads.mockReturnValue({ data: { items: [] }, isLoading: false });
    useRegistrationLinks.mockReturnValue({ data: [], isLoading: false });

    renderPage();

    await user.click(screen.getByText('Go to Bulk Upload'));
    expect(pushMock).toHaveBeenCalledWith('/onboarding/bulk-uploads');

    await user.click(screen.getByText('Create new link'));
    expect(pushMock).toHaveBeenCalledWith('/onboarding/links');
  });

  it('reloads the window on refresh click', async () => {
    const user = userEvent.setup();
    useRecentBulkUploads.mockReturnValue({ data: { items: [] }, isLoading: false });
    useRegistrationLinks.mockReturnValue({ data: [], isLoading: false });
    const reloadSpy = vi.fn();
    const origLocation = window.location;
    Object.defineProperty(window, 'location', {
      writable: true,
      configurable: true,
      value: { ...origLocation, reload: reloadSpy },
    });

    renderPage();
    await user.click(screen.getAllByText('Refresh')[0]!);
    expect(reloadSpy).toHaveBeenCalled();

    Object.defineProperty(window, 'location', {
      writable: true,
      configurable: true,
      value: origLocation,
    });
  });
});
