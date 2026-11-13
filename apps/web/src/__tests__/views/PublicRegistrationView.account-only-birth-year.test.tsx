/**
 * View test: <PublicRegistrationView /> — the birth year an account-only
 * registrant selected has to be the one that reaches the wire.
 *
 * THE BUG THIS FILE PROVES. `performSubmit` stamped `year_of_birth` from this
 * component's own `yearOfBirth` state. On the account-only surface that state
 * is never written: `MinimalIdentityForm` owns the field in its own local
 * state and exposes the value only inside the submitted payload. The stamp
 * therefore overwrote a real selection with `''`, the API derived no age from
 * it, and Signals rejected the push:
 *
 *   SIGNALSTACK_PUSH_FAILED / "signalstack onboard returned 400:
 *   AGE_REQUIRED: age is required with consent on this domain"
 *
 * on every guardian-gated domain — which is every domain that shows the field
 * at all. Both submit paths are covered because the fix threads the resolved
 * year through both: an adult goes via the consent gate (`handleGateAccept`),
 * a minor bypasses it and calls `performSubmit` straight from `handleSubmit`.
 *
 * `ConsentGate` is shimmed the way the sibling account-only consent tests
 * shim it (capture props, fire `onAccept` directly); its scroll-to-unlock
 * mechanics belong to `ConsentGate.test.tsx`.
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

let capturedGateProps: { open: boolean; onAccept: () => void; onCancel?: () => void } | undefined;

vi.mock('@/components/consent/ConsentGate', () => ({
  ConsentGate: (props: { open: boolean; onAccept: () => void; onCancel?: () => void }) => {
    capturedGateProps = props;
    if (!props.open) return null;
    return <div role="dialog" aria-label="consent-gate-shim" />;
  },
}));

const cfgMock = vi.hoisted(() => ({
  value: undefined as Record<string, unknown> | undefined,
  fallback: { brand: { short_name: 'Blue Dots' }, domains: [] },
}));
vi.mock('@/hooks/useAggregatorConfig', () => ({
  useAggregatorConfig: () => ({ data: cfgMock.value, isError: false }),
  DEFAULT_AGGREGATOR_CONFIG: cfgMock.fallback,
}));

// Pull the view after mocks register.
import { PublicRegistrationView } from '@/app/[org]/[slug]/PublicRegistrationView';

const CONSENT_CONTENT: ParticipantConsent = {
  terms: { version: 1, title: 'Terms of Service', content: 'Terms body' },
  privacy: { version: 1, title: 'Privacy Policy', content: 'Privacy body' },
  profileCreation: { version: 1, statement: 'We will use your data to build a profile.' },
};

const CURRENT_YEAR = new Date().getFullYear();
/** Comfortably adult, so the consent gate is required. */
const ADULT_YEAR = String(CURRENT_YEAR - 30);
/** 15 years old: consent is skipped and the gate never opens (§4.4). */
const MINOR_YEAR = String(CURRENT_YEAR - 15);

/**
 * Renders the account-only surface on a guardian-gated domain — the only
 * configuration that shows the birth-year field.
 *
 * `network` is deliberately not passed, so `runIdentityProbe` short-circuits
 * and the only fetch is the submit itself.
 */
function renderView() {
  cfgMock.value = {
    brand: { short_name: 'Blue Dots', primary_color: '#2563EB' },
    domains: [
      {
        id: 'seeker',
        label: 'Seeker',
        go_live_required: ['schema_required', 'consent_required'],
        guardian_consent_required: true,
      },
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

/** Stubs fetch with a 200 submit response and returns the mock. */
function stubFetch(submissionId: string) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ outcome: 'passed', submission_id: submissionId }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/** Body of the POST to `/submit`, parsed. */
function submitBody(fetchMock: ReturnType<typeof stubFetch>): Record<string, unknown> {
  const call = fetchMock.mock.calls.find(([url, init]) => {
    const method = (init as RequestInit | undefined)?.method;
    return String(url).endsWith('/submit') && method === 'POST';
  });
  expect(call, 'expected a POST to /submit').toBeDefined();
  return JSON.parse(String((call![1] as RequestInit).body)) as Record<string, unknown>;
}

function fillIdentity(birthYear: string) {
  fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Jane Doe' } });
  fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '9876543210' } });
  fireEvent.change(screen.getByLabelText(/Year of birth/i), { target: { value: birthYear } });
}

beforeEach(() => {
  capturedGateProps = undefined;
});

describe('<PublicRegistrationView /> account-only birth year', () => {
  it('POSTs the year the registrant selected, not an empty string', async () => {
    const fetchMock = stubFetch('sub-1');

    renderView();
    fillIdentity(ADULT_YEAR);
    fireEvent.click(screen.getByRole('checkbox', { name: /permit the aggregator/i }));
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));

    // Adult on a consent domain: the gate opens and the POST happens on accept.
    await waitFor(() => expect(capturedGateProps?.open).toBe(true));
    act(() => {
      capturedGateProps!.onAccept();
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = submitBody(fetchMock);
    expect(body['year_of_birth']).toBe(ADULT_YEAR);
    // The value has to survive alongside the consent stamp, since both are
    // applied in the same object literal.
    expect(body['consent_terms']).toBe(true);
  });

  it('POSTs the selected year on the no-gate (minor) path too', async () => {
    const fetchMock = stubFetch('sub-2');

    renderView();
    fillIdentity(MINOR_YEAR);
    // No call-consent tick: a minor establishes no consent here, so the form
    // does not require it and the gate is never opened.
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(capturedGateProps?.open ?? false).toBe(false);
    const body = submitBody(fetchMock);
    expect(body['year_of_birth']).toBe(MINOR_YEAR);
    // A minor's consent is collected later in the Signals app, so the stamp
    // must be false here even though the domain shows the consent step.
    expect(body['consent_terms']).toBe(false);
  });

  it('keeps the field blocking, so no submit can carry an empty year', async () => {
    stubFetch('sub-3');
    renderView();

    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Jane Doe' } });
    fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '9876543210' } });

    expect(screen.getByRole('button', { name: /submit/i })).toBeDisabled();
    expect(
      screen.getByText(messages.profile.public_reg.account_only.blockers.year_of_birth),
    ).toBeInTheDocument();
  });
});
