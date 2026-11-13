/**
 * Tests for `OnboardingMetrics` — the aggregator-wide onboarding summary
 * section (stat cards + joins-by-entry-mode bar) at the top of the
 * Onboarding page.
 *
 * Covers: error state (with retry refetching both queries), loading
 * skeletons, normal render with registered + unregistered entry sources
 * (icon/colour/label fallback), the zero-total percentage guard, and the
 * "no sources yet" case where the by-mode card is omitted entirely.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';

const { useOnboardingSummary, useOnboardingBySource } = vi.hoisted(() => ({
  useOnboardingSummary: vi.fn(),
  useOnboardingBySource: vi.fn(),
}));
vi.mock('@/hooks/useOnboarding', () => ({
  useOnboardingSummary: () => useOnboardingSummary(),
  useOnboardingBySource: () => useOnboardingBySource(),
}));

import { OnboardingMetrics } from '@/app/(protected)/onboarding/_components/OnboardingMetrics';

function renderMetrics() {
  return render(
    <NextIntlClientProvider locale="en" messages={{ dashboard: messages.dashboard }}>
      <OnboardingMetrics />
    </NextIntlClientProvider>,
  );
}

describe('<OnboardingMetrics />', () => {
  afterEach(() => vi.clearAllMocks());

  it('renders an error state with a working retry that refetches both queries', async () => {
    const summaryRefetch = vi.fn();
    const bySourceRefetch = vi.fn();
    useOnboardingSummary.mockReturnValue({
      isError: true,
      isLoading: false,
      data: undefined,
      refetch: summaryRefetch,
    });
    useOnboardingBySource.mockReturnValue({
      data: undefined,
      refetch: bySourceRefetch,
    });

    const user = userEvent.setup();
    renderMetrics();

    expect(screen.getByText('Couldn’t load onboarding summary')).toBeInTheDocument();
    await user.click(screen.getByText('Retry'));
    expect(summaryRefetch).toHaveBeenCalled();
    expect(bySourceRefetch).toHaveBeenCalled();
  });

  it('renders loading skeleton cards while the summary query is in flight', () => {
    useOnboardingSummary.mockReturnValue({ isError: false, isLoading: true, data: undefined });
    useOnboardingBySource.mockReturnValue({ data: undefined });

    renderMetrics();

    expect(screen.queryByText('Total submissions')).not.toBeInTheDocument();
    expect(screen.queryByText('Joins by entry mode')).not.toBeInTheDocument();
  });

  it('renders stat cards with formatted counts and the by-mode bar for registered + unregistered sources', () => {
    useOnboardingSummary.mockReturnValue({
      isError: false,
      isLoading: false,
      data: { total: 1234, passed: 900, failed: 50, skipped: 10 },
    });
    useOnboardingBySource.mockReturnValue({
      data: {
        by_source: [
          { source: 'bulk', total: 500, passed: 400, failed: 20, skipped: 5 },
          { source: 'link', total: 300, passed: 250, failed: 10, skipped: 2 },
          { source: 'partner_referral', total: 200, passed: 150, failed: 5, skipped: 1 },
        ],
      },
    });

    renderMetrics();

    expect(screen.getByText('1,234')).toBeInTheDocument();
    expect(screen.getByText('900')).toBeInTheDocument();
    expect(screen.getByText('50')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();

    expect(screen.getByText('Joins by entry mode')).toBeInTheDocument();
    // Registered sources use their i18n label.
    expect(screen.getByText('CSV upload')).toBeInTheDocument();
    expect(screen.getByText('Registration link')).toBeInTheDocument();
    // Unregistered source falls back to a title-cased label.
    expect(screen.getByText('Partner Referral')).toBeInTheDocument();
    // totalJoins = 400+250+150 = 800; percentages shown next to each passed count.
    expect(screen.getByText('800 verified joins')).toBeInTheDocument();
  });

  it('renders "—" for null/undefined summary counts', () => {
    useOnboardingSummary.mockReturnValue({
      isError: false,
      isLoading: false,
      data: { total: null, passed: undefined, failed: 0, skipped: 3 },
    });
    useOnboardingBySource.mockReturnValue({ data: { by_source: [] } });

    renderMetrics();

    expect(screen.getAllByText('—')).toHaveLength(2);
    expect(screen.getByText('0')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('omits the by-mode card entirely when there are no source slices', () => {
    useOnboardingSummary.mockReturnValue({
      isError: false,
      isLoading: false,
      data: { total: 5, passed: 5, failed: 0, skipped: 0 },
    });
    useOnboardingBySource.mockReturnValue({ data: { by_source: [] } });

    renderMetrics();

    expect(screen.queryByText('Joins by entry mode')).not.toBeInTheDocument();
  });

  it('shows 0% for every slice when totalJoins is zero (all passed counts are zero)', () => {
    useOnboardingSummary.mockReturnValue({
      isError: false,
      isLoading: false,
      data: { total: 5, passed: 0, failed: 5, skipped: 0 },
    });
    useOnboardingBySource.mockReturnValue({
      data: { by_source: [{ source: 'bulk', total: 5, passed: 0, failed: 5, skipped: 0 }] },
    });

    renderMetrics();

    expect(screen.getByText('0%')).toBeInTheDocument();
  });
});
