/**
 * View test: <PublicRegistrationView /> — the blocking consent gate wired
 * into the `submission_shape === 'account_only'` (MinimalIdentityForm)
 * submit pipeline (#636 Task 8).
 *
 * Structural coverage only (gate opens / does not open, document count,
 * the surviving call-permission checkbox). The accept → resubmit round trip
 * that proves the consent-recording bug fix lives in
 * `PublicRegistrationView.account-only-consent-submit.test.tsx`, which mocks
 * `ConsentGate` the same way `PublicRegistrationView.lookup.test.tsx` does —
 * jsdom never lays out the real gate's scrollable reader, so its checkbox
 * cannot be unlocked without stubbing scroll geometry (see
 * `read-progress.ts`'s "unmeasured is not evidence of anything" guard).
 *
 * `ConsentGate` itself is NOT mocked here (unlike that sibling file): the
 * tracker-node assertions need the real gate, the same way
 * `PublicRegistrationView.consent-gate.test.tsx` covers the full-profile
 * surface.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import messages from '@/i18n/messages/en.json';
import type { ParticipantConsent } from '@/components/consent/consent-types';

// jsdom does not implement scrollIntoView; the error banner's focus effect
// calls it whenever state transitions to 'error'.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

// This file's tests render the full view tree (react-query + the real
// ConsentGate) more than once each; observed to occasionally trip the
// default 5s timeout under concurrent system load even though the actual
// work completes in ~1-2s (confirmed by rerunning slow instances with a
// larger timeout, which pass comfortably well under it) — not a hang.
vi.setConfig({ testTimeout: 15000 });

// ResizeObserver is stubbed globally in src/__tests__/setup.ts.

// Config drives showConsent via the domain's go_live_required — same shape as
// PublicRegistrationView.consent-gate.test.tsx. No guardian_consent_required
// here except where a test opts in explicitly: the account-only + consent-gate
// interaction doesn't otherwise need the birth-year field.
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
  // Present on the copy the aggregator loads (a real ParticipantConsent
  // always carries all three documents), but the account-only gate must
  // exclude it — see "excludes the profile document" below.
  profileCreation: { version: 1, statement: 'We will use your data to build a profile.' },
};

interface RenderOpts {
  showConsent: boolean;
  birthYear?: number;
  consentContent?: ParticipantConsent | null;
}

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
          schema={{ type: 'object', properties: {} }}
          uiSchema={{}}
          identity={{ name: 'name', phone: 'phone', email: 'email' }}
          submissionShape="account_only"
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

/** Fills the minimum required identity fields and ticks the call-permission checkbox. */
function fillAndTickCallConsent() {
  fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Jane Doe' } });
  fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '9876543210' } });
  fireEvent.click(screen.getByRole('checkbox', { name: /permit the aggregator/i }));
}

describe('<PublicRegistrationView /> account-only consent gate', () => {
  it('opens the gate on submit', async () => {
    renderView({ showConsent: true });
    fillAndTickCallConsent();
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('shows exactly two tracker nodes — privacy and terms — and excludes the profile document', async () => {
    renderView({ showConsent: true });
    fillAndTickCallConsent();
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    await screen.findByRole('dialog');
    expect(screen.getByTestId('consent-node-privacy')).toBeInTheDocument();
    expect(screen.getByTestId('consent-node-terms')).toBeInTheDocument();
    expect(screen.queryByTestId('consent-node-profile')).not.toBeInTheDocument();
  });

  it('keeps the call-permission checkbox and still blocks submit when it is unticked', () => {
    renderView({ showConsent: true });
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Jane Doe' } });
    fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '9876543210' } });
    expect(
      screen.getByRole('checkbox', { name: /permit the aggregator to trigger the call/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /submit/i })).toBeDisabled();
  });

  it('never opens the gate for a minor', async () => {
    renderView({ showConsent: true, birthYear: new Date().getFullYear() - 15 });
    // No consent checkbox at all for a minor — the U18 notice replaces it,
    // so the identity fields alone satisfy validity.
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Kid' } });
    fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '9876543210' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /submit/i }));
      await Promise.resolve();
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('never opens the gate when the domain does not require consent', async () => {
    renderView({ showConsent: false });
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Jane Doe' } });
    fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '9876543210' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /submit/i }));
      await Promise.resolve();
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('mounts the gate closed, opens it on submit, and completes it after scrolling to the end', async () => {
    // Unlike every other test in this file, which only checks the gate
    // OPENS, this drives it all the way through — the real reproduction of
    // the mount-timing Critical: `ConsentGate` mounts closed (nothing in the
    // DOM for `useReadProgress` to measure), `handleSubmit` flips it open,
    // and only a gate that re-measures on THAT transition can ever unlock.
    const originalFetch = globalThis.fetch;
    const calls: { url: string; body: string }[] = [];
    globalThis.fetch = vi.fn(async (input: unknown, init?: { body?: string }) => {
      calls.push({ url: String(input), body: init?.body ?? '' });
      return new Response(JSON.stringify({ submission_id: 'sub_123', outcome: 'passed' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    try {
      renderView({ showConsent: true });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

      fillAndTickCallConsent();
      fireEvent.click(screen.getByRole('button', { name: /submit/i }));
      await screen.findByRole('dialog');

      const checkbox = screen.getByRole('checkbox', { name: /I have read and accept/i });
      expect(checkbox).toBeDisabled();

      const el = screen.getByTestId('consent-reader');
      Object.defineProperty(el, 'scrollHeight', { value: 600, configurable: true });
      Object.defineProperty(el, 'clientHeight', { value: 200, configurable: true });
      Object.defineProperty(el, 'scrollTop', { value: 400, writable: true, configurable: true });
      const readerTop = 149; // nonzero: a real reader is never flush with the viewport edge
      el.getBoundingClientRect = () =>
        ({ top: readerTop, height: 200, bottom: readerTop + 200 }) as DOMRect;
      const contentTops: Record<string, number> = { privacy: 0, terms: 300 };
      for (const id of ['privacy', 'terms']) {
        const section = el.querySelector<HTMLElement>(`[data-consent-section="${id}"]`)!;
        section.getBoundingClientRect = () =>
          ({
            top: readerTop + contentTops[id]! - 400,
            height: 300,
            bottom: readerTop + contentTops[id]! - 400 + 300,
          }) as DOMRect;
      }
      fireEvent.scroll(el);

      await waitFor(() => expect(checkbox).toBeEnabled());
      fireEvent.click(checkbox);
      fireEvent.click(screen.getByRole('button', { name: 'Accept & continue' }));

      await waitFor(() => expect(calls.length).toBe(1));
      expect(calls[0]!.url).toContain('/submit');
      const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
      expect(body['consent_terms']).toBe(true);
      expect(body['consent_privacy']).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('cancelling the gate preserves the identity fields already entered, and the form stays submittable', async () => {
    // Important: `handleSubmit` sets `state.status` to `submitting` before
    // the (synchronous-when-`network`-is-unset) pre-submit probe resolves,
    // which used to fail the `isAccountOnly && state.status === 'idle'`
    // check and unmount MinimalIdentityForm — whose name/phone/email/
    // birth-year/consentCall are all component-local state. Opening the
    // gate set `status` back to `idle`, remounting a brand-new (empty)
    // instance underneath the now-open gate. Cancelling used to reveal that
    // empty form; this proves the fields survive the whole round trip.
    //
    // Field values alone are not enough, though — asserting only those is
    // exactly what let a real regression through once already: fixing the
    // remount left MinimalIdentityForm's own local `submitting` flag (set on
    // submit, never reset anywhere in the file) permanently `true` once the
    // form stopped being torn down and rebuilt on every transition, so the
    // Submit button stayed disabled forever after the very first submit —
    // dead exactly the way a field operator correcting a typo would hit it.
    // So this also asserts the button is enabled again after cancelling, and
    // that a second submit genuinely re-opens the gate rather than silently
    // no-op'ing on a disabled button.
    renderView({ showConsent: true });
    fillAndTickCallConsent();

    const nameInput = screen.getByLabelText(/Name/);
    const phoneInput = screen.getByLabelText(/Phone/);
    expect(nameInput).toHaveValue('Jane Doe');
    expect(phoneInput).toHaveValue('9876543210');

    const submitButton = screen.getByRole('button', { name: /submit/i });
    fireEvent.click(submitButton);
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    expect(screen.getByLabelText(/Name/)).toHaveValue('Jane Doe');
    expect(screen.getByLabelText(/Phone/)).toHaveValue('9876543210');
    expect(screen.getByRole('checkbox', { name: /permit the aggregator/i })).toBeChecked();

    // The regression this pins: without it, this button stays disabled
    // forever and the second click below would never re-open the gate.
    expect(screen.getByRole('button', { name: /submit/i })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('shows a visible error instead of a dead submit when consent copy failed to load', async () => {
    renderView({ showConsent: true, consentContent: null });
    fillAndTickCallConsent();
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(messages.register.consent.load_failed_title)).toBeInTheDocument();
    expect(screen.getByText(messages.register.consent.load_failed_detail)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
