/**
 * View test: <RegisterPageShell /> (#619) — the shared registration chrome.
 *
 * Covers both header branches: a configured brand logo renders an <img>; with
 * no logo the fallback BlueDotsLogo + wordmark render. Also asserts the heading,
 * children (form slot), and the Terms/Privacy footer links.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import messages from '@/i18n/messages/en.json';

const { useAggregatorConfig } = vi.hoisted(() => ({ useAggregatorConfig: vi.fn() }));

vi.mock('@/hooks/useAggregatorConfig', () => ({
  useAggregatorConfig,
  DEFAULT_AGGREGATOR_CONFIG: { brand: { short_name: 'Blue Dots' } },
}));

// next/image → plain <img> so the src/alt assert works in jsdom.
vi.mock('next/image', () => ({
  default: ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} />,
}));

import { RegisterPageShell } from '@/app/(public)/register/RegisterPageShell';

function renderShell(cfg: Record<string, unknown>) {
  useAggregatorConfig.mockReturnValue({ data: cfg, isLoading: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={messages}>
        <RegisterPageShell heading="My Heading">
          <div data-testid="form-slot">form</div>
        </RegisterPageShell>
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

describe('RegisterPageShell', () => {
  afterEach(() => vi.clearAllMocks());

  it('renders the brand logo <img> when brand.logo.default is set', () => {
    renderShell({ brand: { short_name: 'Purple Dots', logo: { default: '/brand/x/logo.png' } } });
    const img = screen.getByRole('img', { name: 'Purple Dots' });
    expect(img).toHaveAttribute('src', '/brand/x/logo.png');
    expect(screen.getByRole('heading', { name: 'My Heading' })).toBeInTheDocument();
    expect(screen.getByTestId('form-slot')).toBeInTheDocument();
  });

  it('falls back to the wordmark when no brand logo is configured', () => {
    renderShell({ brand: { short_name: 'Blue Dots' } });
    // No next/image logo in the fallback branch (only the BlueDotsLogo SVG).
    expect(screen.queryByAltText('Blue Dots')).toBeNull();
    // "Aggregator Portal" is unique to the fallback wordmark block.
    expect(screen.getByText('Aggregator Portal')).toBeInTheDocument();
  });

  it('renders the Terms/Privacy footer links', () => {
    renderShell({ brand: { short_name: 'Blue Dots' } });
    expect(screen.getByText(messages.register.consent.privacy_link)).toBeInTheDocument();
    expect(screen.getByText(messages.register.consent.terms_link)).toBeInTheDocument();
  });
});
