/**
 * View test: <OrgRegisterForm /> with the REAL {@link ConsentGate} — not the
 * shim `OrgRegisterForm.test.tsx` uses.
 *
 * This is the test that would have caught the mount-timing Critical: the
 * gate mounts closed (`gateOpen` starts `false`), submitting the form flips
 * it open — the exact `false -> true` transition production goes through,
 * and the one no shimmed-gate test can ever exercise, because a shim never
 * renders `useReadProgress` at all.
 *
 * @module apps/web/src/__tests__/views/OrgRegisterForm.real-gate.test.tsx
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
        onSubmit({ formData: { display_name: 'Enable India' } }, ev);
      }}
    >
      {children}
    </form>
  ),
}));

// ConsentGate is NOT mocked here — that is the entire point of this file.

import { OrgRegisterForm } from '@/app/(public)/register/OrgRegisterForm';

const orgSchema = {
  title: 'Organisation Registration',
  type: 'object',
  properties: { display_name: { type: 'string', title: 'Display Name' } },
} as never;

const consentContentFixture = {
  terms: { version: 1, title: 'Terms of Service', content: 'Terms body' },
  privacy: { version: 1, title: 'Privacy Policy', content: 'Privacy body' },
};

/**
 * Stubs the mounted `consent-reader` as a taller-than-viewport scroller and
 * positions its `privacy`/`terms` sections via `getBoundingClientRect`, the
 * same honest, browser-coordinate-space stub `ConsentGate.test.tsx` uses (a
 * nonzero reader viewport `top`, so a regression to `offsetTop`-style
 * measurement would fail this too, not just pass by accident).
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
  client.setQueryData(['org-parents'], {
    accepting: true,
    parents: [
      {
        id: 'p-root',
        name: 'Blue Dots',
        is_root: true,
        known_as_name: null,
        child_known_as_name: 'Aggregator',
      },
    ],
  });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={messages}>
        <OrgRegisterForm schema={orgSchema} uiSchema={{}} consentContent={consentContentFixture} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

describe('<OrgRegisterForm /> with the real ConsentGate', () => {
  it('mounts the gate closed, opens it on submit, and completes it after scrolling to the end', async () => {
    let calls: { url: string; body: string }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: unknown, init?: { body?: string }) => {
      calls.push({ url: String(input), body: init?.body ?? '' });
      return new Response(JSON.stringify({ slug: 'enable-india-ab12' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    try {
      renderForm();

      // The gate is mounted CLOSED at first render — no dialog, no reader.
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

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
      const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
      expect(body['display_name']).toBe('Enable India');
      expect(body['consent']).toMatchObject({ value: true });
      expect(await screen.findByText('enable-india-ab12')).toBeInTheDocument();
    } finally {
      globalThis.fetch = originalFetch;
      calls = [];
    }
  });
});
