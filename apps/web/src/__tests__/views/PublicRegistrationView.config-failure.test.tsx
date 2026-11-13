/**
 * View test: what the public registration page does when
 * `GET /api/aggregator-config` fails.
 *
 * The view treats an errored config query as "settled" and renders on
 * `DEFAULT_AGGREGATOR_CONFIG`. That is deliberate — a participant with a
 * printed QR code must still be able to register during a config outage — but
 * it is also the branch nothing covered: the sibling signals-cta test's mock
 * hardcodes `isError: false`, so the failure path never ran. Kept in its own
 * file because it needs `isError: true` for the whole file.
 *
 * The degradation itself is asserted here too: with no `signals_ui_urls` in the
 * default payload the chooser disappears, which is exactly why the failure is
 * logged rather than swallowed (see `useAggregatorConfig`).
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import messages from '@/i18n/messages/en.json';

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

vi.mock('@/components/forms/RjsfThemed', () => ({
  RjsfThemedForm: ({ children }: { children?: React.ReactNode }) => (
    <form data-testid="rjsf-shim">{children}</form>
  ),
}));

// The whole point of the file: `data` never arrives and the query has errored.
const cfgMock = vi.hoisted(() => ({
  fallback: {
    brand: { short_name: 'Blue Dots' },
    domains: [{ id: 'seeker', label: 'Seeker', plural_label: 'Seekers', item_type: 'profile_1.0' }],
  },
}));
vi.mock('@/hooks/useAggregatorConfig', () => ({
  useAggregatorConfig: () => ({ data: undefined, isError: true }),
  DEFAULT_AGGREGATOR_CONFIG: cfgMock.fallback,
}));

import { PublicRegistrationView } from '@/app/[org]/[slug]/PublicRegistrationView';

function renderView() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={messages as Record<string, unknown>}>
        <PublicRegistrationView
          org="acme"
          slug="winter25"
          network="blue_dot"
          domain="seeker"
          context={{ title: 'Winter 2025 Registration', org_name: 'Acme' }}
          schema={{
            type: 'object',
            properties: { email: { type: 'string' }, name: { type: 'string' } },
          }}
          uiSchema={{}}
          identity={{ name: 'name', phone: 'phone', email: 'email' }}
          submissionShape="account_and_profile"
          publicHintI18nKey={null}
          registrationMode="form"
        />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

describe('public registration page when the aggregator-config fetch fails', () => {
  it('renders the form, not a permanent loading placeholder', () => {
    renderView();
    expect(screen.getByTestId('rjsf-shim')).toBeInTheDocument();
    // The regression this guards: treating `isError` as "still loading" would
    // strand every participant on the skeleton forever.
    expect(screen.queryByTestId('public-reg-loading')).toBeNull();
  });

  it('drops the Signals chooser, because the default payload configures no URL', () => {
    renderView();
    expect(screen.queryByTestId('registration-chooser')).toBeNull();
    expect(screen.queryByRole('link', { name: /already registered/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /back to options/i })).toBeNull();
  });
});
