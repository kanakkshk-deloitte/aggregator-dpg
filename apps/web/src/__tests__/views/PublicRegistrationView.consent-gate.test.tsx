/**
 * View test: <PublicRegistrationView /> — the blocking consent gate wired
 * into the public QR-form submit pipeline (#636 Task 7).
 *
 * RJSF is mocked to the shared thin shim in `./publicRegistrationView.testHelpers`
 * (the same one `PublicRegistrationView.signals-redirect.test.tsx` uses): a
 * deterministic `<form>` whose `onSubmit` is wired straight to the real
 * handler, tagged with a testid so a submit can be fired without depending on
 * RJSF's own validity plumbing. This file's schema declares no `default`
 * values, so the shared shim's formData (built from schema defaults) is
 * always `{}` here — identical to a hand-rolled empty-formData shim, just not
 * a second copy of it. `ConsentGate` itself is NOT mocked — its own
 * scroll-to-unlock mechanics are covered by `ConsentGate.test.tsx`; here we
 * only need the dialog and its tracker nodes to prove the three documents
 * actually reach it.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import messages from '@/i18n/messages/en.json';
import type { ParticipantConsent } from '@/components/consent/consent-types';
import { RjsfShim } from './publicRegistrationView.testHelpers';

// jsdom does not implement scrollIntoView; the error banner's focus effect
// calls it whenever state transitions to 'error'.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

vi.mock('@/components/forms/RjsfThemed', () => ({ RjsfThemedForm: RjsfShim }));

// Config drives showConsent/showBirthYear via the domain's go_live_required /
// guardian_consent_required — same shape as PublicRegistrationView.lookup.test.tsx.
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

interface RenderOpts {
  showConsent: boolean;
  birthYear?: number;
  consentContent?: ParticipantConsent | null;
}

/**
 * Renders the public registration view with a domain config that drives
 * showConsent/showBirthYear the way `registration-gates.ts` expects, and
 * (when `birthYear` is given) types it into the Year-of-birth select so the
 * view's own `isMinor` derivation reflects it before the submit fires.
 */
function renderView(opts: RenderOpts) {
  const domain: Record<string, unknown> = { id: 'seeker', label: 'Seeker' };
  if (opts.showConsent) domain['go_live_required'] = ['schema_required', 'consent_required'];
  if (opts.birthYear !== undefined) domain['guardian_consent_required'] = true;

  cfgMock.value = {
    brand: { short_name: 'Blue Dots', primary_color: '#2563EB' },
    domains: [domain],
  };

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const result = render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={messages as Record<string, unknown>}>
        <PublicRegistrationView
          org="acme"
          slug="winter25"
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
          consentContent={opts.consentContent === undefined ? CONSENT_CONTENT : opts.consentContent}
        />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );

  if (opts.birthYear !== undefined) {
    fireEvent.change(screen.getByLabelText(/Year of birth/), {
      target: { value: String(opts.birthYear) },
    });
  }

  return result;
}

// ResizeObserver is stubbed globally in src/__tests__/setup.ts.

describe('<PublicRegistrationView /> consent gate', () => {
  it('renders no inline consent checkbox on the form', () => {
    renderView({ showConsent: true });
    expect(screen.queryByRole('checkbox', { name: /consent/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('opens the gate with all three documents when submitting without consent', async () => {
    renderView({ showConsent: true });
    fireEvent.submit(screen.getByTestId('rjsf-shim'));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('consent-node-privacy')).toBeInTheDocument();
    expect(screen.getByTestId('consent-node-terms')).toBeInTheDocument();
    expect(screen.getByTestId('consent-node-profile')).toBeInTheDocument();
  });

  it('never opens the gate for a minor', async () => {
    renderView({ showConsent: true, birthYear: new Date().getFullYear() - 15 });
    expect(screen.getByText(messages.profile.public_reg.u18_notice)).toBeInTheDocument();
    // The probe short-circuits synchronously when `network` is unset, but
    // still resolves through a promise chain that updates state — flush it
    // inside `act` so the assertion sees the settled DOM, not a warning.
    await act(async () => {
      fireEvent.submit(screen.getByTestId('rjsf-shim'));
      await Promise.resolve();
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('never opens the gate when the domain does not require consent', async () => {
    renderView({ showConsent: false });
    await act(async () => {
      fireEvent.submit(screen.getByTestId('rjsf-shim'));
      await Promise.resolve();
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('re-opens the gate for a second registration after "Register another", and cannot post consent without it', async () => {
    // The Critical this pins: `handleRegisterAnother` used to reset
    // formData/state/handoff but leave `consentAccepted` (and
    // `yearOfBirth`) untouched. `needsConsentNow` is gated on
    // `!consentAccepted`, so a second person submitted after "Register
    // another" skipped the gate entirely and still posted
    // consent_terms/consent_privacy/consent_profile: true — on the strength
    // of the FIRST person having read the documents.
    const originalFetch = globalThis.fetch;
    const calls: { url: string; body: string }[] = [];
    globalThis.fetch = vi.fn(async (input: unknown, init?: { body?: string }) => {
      calls.push({ url: String(input), body: init?.body ?? '' });
      return new Response(JSON.stringify({ submission_id: 'sub_1', outcome: 'passed' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    try {
      renderView({ showConsent: true });

      // --- Person #1: complete the gate for real. ---
      fireEvent.submit(screen.getByTestId('rjsf-shim'));
      await screen.findByRole('dialog');

      const reader1 = screen.getByTestId('consent-reader');
      // Three 300px sections (privacy/terms/profile) in a 200px viewport —
      // 900px of scrollHeight total, so max scroll is scrollTop 700.
      Object.defineProperty(reader1, 'scrollHeight', { value: 900, configurable: true });
      Object.defineProperty(reader1, 'clientHeight', { value: 200, configurable: true });
      Object.defineProperty(reader1, 'scrollTop', {
        value: 700,
        writable: true,
        configurable: true,
      });
      const readerTop = 149;
      reader1.getBoundingClientRect = () =>
        ({ top: readerTop, height: 200, bottom: readerTop + 200 }) as DOMRect;
      const contentTops: Record<string, number> = { privacy: 0, terms: 300, profile: 600 };
      for (const id of ['privacy', 'terms', 'profile']) {
        const section = reader1.querySelector<HTMLElement>(`[data-consent-section="${id}"]`)!;
        section.getBoundingClientRect = () =>
          ({
            top: readerTop + contentTops[id]! - 700,
            height: 300,
            bottom: readerTop + contentTops[id]! - 700 + 300,
          }) as DOMRect;
      }
      fireEvent.scroll(reader1);

      const checkbox1 = screen.getByRole('checkbox');
      await waitFor(() => expect(checkbox1).toBeEnabled());
      fireEvent.click(checkbox1);
      fireEvent.click(screen.getByRole('button', { name: 'Accept & continue' }));

      await waitFor(() => expect(calls.length).toBe(1));
      expect(JSON.parse(calls[0]!.body)['consent_terms']).toBe(true);

      // --- Reaches "done", then "Register another". ---
      await screen.findByRole('button', { name: messages.profile.public_reg.btn_register_another });
      fireEvent.click(
        screen.getByRole('button', { name: messages.profile.public_reg.btn_register_another }),
      );

      // Back on the form, gate closed — nothing was carried over visibly.
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(await screen.findByTestId('rjsf-shim')).toBeInTheDocument();

      // --- Person #2: submitting again MUST re-open the gate. ---
      fireEvent.submit(screen.getByTestId('rjsf-shim'));
      expect(await screen.findByRole('dialog')).toBeInTheDocument();

      // And the second person's consent is not yet posted — the gate is
      // still waiting on them, not silently reusing person #1's acceptance.
      expect(calls.length).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('shows a visible error instead of a dead submit when consent copy failed to load', async () => {
    renderView({ showConsent: true, consentContent: null });
    fireEvent.submit(screen.getByTestId('rjsf-shim'));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(messages.register.consent.load_failed_title)).toBeInTheDocument();
    expect(screen.getByText(messages.register.consent.load_failed_detail)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
