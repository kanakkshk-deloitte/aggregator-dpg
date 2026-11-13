/**
 * View test: <CoordinatorRegisterForm /> with the REAL {@link ConsentGate} —
 * not a shim.
 *
 * `OrgRegisterForm` already has this proof
 * (`OrgRegisterForm.real-gate.test.tsx`); `CoordinatorRegisterForm` shares
 * identical `gateOpen`/`ConsentGate` wiring but had no equivalent of its own.
 * Same shape: the gate mounts closed (`gateOpen` starts `false`), submitting
 * the form flips it open — the exact `false -> true` transition production
 * goes through, and the one no shimmed-gate test (e.g. `RegisterView.test.tsx`)
 * can ever exercise.
 *
 * @module apps/web/src/__tests__/views/CoordinatorRegisterForm.real-gate.test.tsx
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import messages from '@/i18n/messages/en.json';

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

vi.mock('@/components/forms/RjsfThemed', () => ({
  RjsfThemedForm: ({
    onSubmit,
    children,
  }: {
    onSubmit: (e: { formData: Record<string, unknown> }, ev: unknown) => void;
    children?: ReactNode;
  }) => (
    <form
      data-testid="rjsf-shim"
      onSubmit={(ev) => {
        ev.preventDefault();
        onSubmit({ formData: { name: 'Enable India Coordinator' } }, ev);
      }}
    >
      {children}
    </form>
  ),
}));

// useAggregatorConfig hits the BFF via react-query; CoordinatorRegisterForm
// reads it for the brand name only (org-hierarchy off, so no /api/orgs call).
vi.mock('@/hooks/useAggregatorConfig', () => {
  const cfg = { brand: { short_name: 'Test' }, domains: [{ id: 'seeker', label: 'Seeker' }] };
  return {
    useAggregatorConfig: () => ({ data: cfg, isLoading: false }),
    DEFAULT_AGGREGATOR_CONFIG: cfg,
  };
});

// ConsentGate is NOT mocked here — that is the entire point of this file.

import { CoordinatorRegisterForm } from '@/app/(public)/register/CoordinatorRegisterForm';

const coordSchema = {
  title: 'Aggregator Registration',
  type: 'object',
  properties: { name: { type: 'string', title: 'Organisation Name' } },
} as never;

const consentContentFixture = {
  terms: { version: 1, title: 'Terms of Service', content: 'Terms body' },
  privacy: { version: 1, title: 'Privacy Policy', content: 'Privacy body' },
};

/**
 * Stubs the mounted `consent-reader` as a taller-than-viewport scroller and
 * positions its `privacy`/`terms` sections via `getBoundingClientRect` — a
 * nonzero reader viewport `top`, so a regression to `offsetTop`-style
 * measurement would fail this too, not just pass by accident. Same helper as
 * `OrgRegisterForm.real-gate.test.tsx`.
 */
function rect(top: number, height: number): DOMRect {
  return {
    top,
    height,
    bottom: top + height,
    left: 0,
    right: 0,
    width: 0,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

const READER_VIEWPORT_TOP = 149;

function stubScrollerToMaxAndScroll() {
  const el = screen.getByTestId('consent-reader');
  Object.defineProperty(el, 'scrollHeight', { value: 600, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: 200, configurable: true });
  Object.defineProperty(el, 'scrollTop', { value: 400, writable: true, configurable: true });
  el.getBoundingClientRect = () => rect(READER_VIEWPORT_TOP, 200);
  const tops: Record<string, number> = { privacy: 0, terms: 300 };
  for (const id of ['privacy', 'terms']) {
    const section = el.querySelector<HTMLElement>(`[data-consent-section="${id}"]`)!;
    section.getBoundingClientRect = () => rect(READER_VIEWPORT_TOP + tops[id]! - 400, 300);
  }
  fireEvent.scroll(el);
  return el;
}

function renderForm() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={messages}>
        <CoordinatorRegisterForm
          schema={coordSchema}
          uiSchema={{}}
          consentContent={consentContentFixture}
        />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

describe('<CoordinatorRegisterForm /> with the real ConsentGate', () => {
  it('mounts the gate closed, opens it on submit, and completes it after scrolling to the end', async () => {
    let calls: { url: string; body: string }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: unknown, init?: { body?: string }) => {
      // The org selector's list (always on since 0028) is not a registration.
      if (String(input).includes('/api/orgs')) {
        return new Response(
          JSON.stringify({ orgs: [{ id: 'd', slug: 'default', display_name: 'Default' }] }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }
      calls.push({ url: String(input), body: init?.body ?? '' });
      return new Response(JSON.stringify({ aggregator_id: 'agg-enable-india' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    try {
      renderForm();

      // The gate is mounted CLOSED at first render — no dialog, no reader.
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      // The only org (Default) is preselected once the list loads.
      await screen.findByText('Default');

      // Submitting opens it: false -> true, in the DOM for the first time.
      fireEvent.submit(screen.getByTestId('rjsf-shim'));
      await screen.findByRole('dialog');

      const checkbox = screen.getByRole('checkbox');
      expect(checkbox).toBeDisabled();

      stubScrollerToMaxAndScroll();

      await waitFor(() => expect(checkbox).toBeEnabled());
      fireEvent.click(checkbox);
      fireEvent.click(screen.getByRole('button', { name: 'Accept & continue' }));

      await waitFor(() => expect(calls.length).toBe(1));
      expect(calls[0]!.url).toBe('/api/aggregator/register');
      const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
      expect(body['name']).toBe('Enable India Coordinator');
      expect(body['consent']).toMatchObject({ value: true });
      expect(await screen.findByText('agg-enable-india')).toBeInTheDocument();
    } finally {
      globalThis.fetch = originalFetch;
      calls = [];
    }
  });
});
