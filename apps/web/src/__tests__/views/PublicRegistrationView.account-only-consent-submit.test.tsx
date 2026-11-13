/**
 * View test: <PublicRegistrationView /> — the account-only submit pipeline's
 * consent payload, end to end (#636 Task 8).
 *
 * This is the file that proves and fixes the consent-recording bug: on the
 * `submission_shape === 'account_only'` surface, `needsConsent` used to
 * exclude `isAccountOnly` outright, so no gate ever opened here — the form
 * fell straight through to `performSubmit`, whose `consentGiven` argument is
 * `consentAccepted` state that nothing on this path ever set `true`. A
 * registrant who genuinely consented was recorded as `consent_terms: false`.
 *
 * `ConsentGate` is mocked exactly the way `PublicRegistrationView.lookup.test.tsx`
 * mocks it (capture the props, reach in and fire `onAccept` directly) — its
 * own scroll-to-unlock mechanics are covered by `ConsentGate.test.tsx` and by
 * the real-gate structural assertions in
 * `PublicRegistrationView.account-only-consent-gate.test.tsx`; this file only
 * needs to prove the right consent booleans reach the wire.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import messages from '@/i18n/messages/en.json';
import type { ParticipantConsent } from '@/components/consent/consent-types';

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

// Shim ConsentGate exactly as PublicRegistrationView.lookup.test.tsx does:
// capture the props and let the test fire `onAccept` directly, bypassing the
// real gate's scroll-to-unlock mechanics.
let capturedGateProps: { open: boolean; onAccept: () => void; onCancel?: () => void } | undefined;

vi.mock('@/components/consent/ConsentGate', () => ({
  ConsentGate: (props: { open: boolean; onAccept: () => void; onCancel?: () => void }) => {
    capturedGateProps = props;
    if (!props.open) return null;
    return <div role="dialog" aria-label="consent-gate-shim" />;
  },
}));

const gateShim = {
  async opened() {
    await waitFor(() => expect(capturedGateProps?.open).toBe(true));
    return capturedGateProps!;
  },
};

const cfgMock = vi.hoisted(() => ({
  value: undefined as Record<string, unknown> | undefined,
  fallback: { brand: { short_name: 'Blue Dots' }, domains: [] },
}));
vi.mock('@/hooks/useAggregatorConfig', () => ({
  useAggregatorConfig: () => ({ data: cfgMock.value, isError: false }),
  DEFAULT_AGGREGATOR_CONFIG: cfgMock.fallback,
}));

beforeEach(() => {
  capturedGateProps = undefined;
});

// Pull the view after mocks register.
import { PublicRegistrationView } from '@/app/[org]/[slug]/PublicRegistrationView';

const CONSENT_CONTENT: ParticipantConsent = {
  terms: { version: 1, title: 'Terms of Service', content: 'Terms body' },
  privacy: { version: 1, title: 'Privacy Policy', content: 'Privacy body' },
  profileCreation: { version: 1, statement: 'We will use your data to build a profile.' },
};

function renderView() {
  cfgMock.value = {
    brand: { short_name: 'Blue Dots', primary_color: '#2563EB' },
    domains: [
      { id: 'seeker', label: 'Seeker', go_live_required: ['schema_required', 'consent_required'] },
    ],
  };

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={messages as Record<string, unknown>}>
        <PublicRegistrationView
          org="acme"
          slug="winter25"
          domain="seeker"
          context={{ title: 'Winter 2025 Registration', org_name: 'Acme' }}
          schema={{ type: 'object', properties: {} }}
          uiSchema={{}}
          identity={{ name: 'name', phone: 'phone', email: 'email' }}
          submissionShape="account_only"
          publicHintI18nKey={null}
          consentContent={CONSENT_CONTENT}
        />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

function fillAndTickCallConsent() {
  fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Jane Doe' } });
  fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '9876543210' } });
  fireEvent.click(screen.getByRole('checkbox', { name: /permit the aggregator/i }));
}

describe('<PublicRegistrationView /> account-only consent submit', () => {
  // THE BUG-PROVING TEST. Written first, run against pre-fix code (see the
  // task report for the captured failing output), then made to pass by the
  // `needsConsent` + `performSubmit` fix.
  it('records consent_terms: true on an account-only submission with consent given', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ outcome: 'passed', submission_id: 'sub-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    renderView();
    fillAndTickCallConsent();
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));

    const gateProps = await gateShim.opened();
    act(() => {
      gateProps.onAccept();
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body)) as {
      consent_terms?: boolean;
    };
    expect(body.consent_terms).toBe(true);
  });

  it('POSTs consent_terms/consent_privacy true and omits consent_profile entirely', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ outcome: 'passed', submission_id: 'sub-2' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    renderView();
    fillAndTickCallConsent();
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));

    const gateProps = await gateShim.opened();
    act(() => {
      gateProps.onAccept();
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body)) as Record<
      string,
      unknown
    >;
    expect(body['consent_terms']).toBe(true);
    expect(body['consent_privacy']).toBe(true);
    expect('consent_profile' in body).toBe(false);
  });
});
