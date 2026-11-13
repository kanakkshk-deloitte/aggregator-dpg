/**
 * View test: <OwnerRegisterView /> — the `/register/owner` deep-link flow (#619).
 *
 * Owner (organisation) registration used to be a tab on RegisterView; it now
 * has its own view/route. Covers: the org form renders, the consent block is
 * stripped from the schema handed to RJSF, submit opens the gate (posts
 * nothing) then accepting posts to /api/org/register, and a failed consent copy
 * surfaces a visible error without posting.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import messages from '@/i18n/messages/en.json';

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

let capturedSchema: unknown;

vi.mock('@/components/forms/RjsfThemed', () => ({
  RjsfThemedForm: ({
    schema,
    onSubmit,
    children,
  }: {
    schema?: unknown;
    onSubmit: (e: { formData: Record<string, unknown> }, ev: unknown) => void;
    children?: ReactNode;
  }) => {
    capturedSchema = schema;
    return (
      <form
        data-testid="rjsf-shim"
        onSubmit={(ev) => {
          ev.preventDefault();
          onSubmit({ formData: { name: 'Acme Org' } }, ev);
        }}
      >
        {children}
      </form>
    );
  },
}));

let capturedGateProps: { open: boolean; onAccept: () => void; onCancel?: () => void } | undefined;

vi.mock('@/components/consent/ConsentGate', () => ({
  ConsentGate: (props: { open: boolean; onAccept: () => void; onCancel?: () => void }) => {
    capturedGateProps = props;
    if (!props.open) return null;
    return (
      <div role="dialog" aria-label="consent-gate-shim">
        <button type="button" onClick={props.onAccept}>
          Accept (shim)
        </button>
      </div>
    );
  },
}));

vi.mock('@/hooks/useAggregatorConfig', () => {
  const cfg = { brand: { short_name: 'Test' }, domains: [{ id: 'seeker', label: 'Seeker' }] };
  return {
    useAggregatorConfig: () => ({ data: cfg, isLoading: false }),
    DEFAULT_AGGREGATOR_CONFIG: cfg,
  };
});

import { OwnerRegisterView } from '@/app/(public)/register/owner/OwnerRegisterView';

const orgSchema = { title: 'Organisation Registration', type: 'object', properties: {} } as never;
const consentContentFixture = {
  terms: { version: 1, title: 'Terms', content: 'Terms body' },
  privacy: { version: 1, title: 'Privacy', content: 'Privacy body' },
};

function renderView(props: Record<string, unknown> = {}) {
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
        <OwnerRegisterView
          schema={orgSchema}
          uiSchema={{}}
          orgConsentContent={consentContentFixture}
          {...props}
        />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

describe('OwnerRegisterView', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it('renders the org form with no tabs', () => {
    globalThis.fetch = vi.fn(
      async () => new Response('{}', { status: 200 }),
    ) as unknown as typeof fetch;
    renderView();
    expect(screen.getByTestId('rjsf-shim')).toBeInTheDocument();
    expect(screen.queryByRole('tab')).toBeNull();
  });

  it('strips the consent block from the schema handed to RJSF', () => {
    globalThis.fetch = vi.fn(
      async () => new Response('{}', { status: 200 }),
    ) as unknown as typeof fetch;

    const schemaWithConsent = {
      type: 'object',
      required: ['name', 'consent'],
      properties: {
        name: { type: 'string' },
        consent: {
          type: 'object',
          title: 'Terms & Privacy Consent',
          required: ['value'],
          properties: { value: { type: 'boolean' } },
        },
      },
    } as never;

    renderView({ schema: schemaWithConsent });

    const rendered = capturedSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(rendered.properties).not.toHaveProperty('consent');
    expect(rendered.required).not.toContain('consent');
  });

  it('submitting opens the gate, posts nothing, then accepting posts consent.value:true to /api/org/register', async () => {
    const calls: { url: string; body: string }[] = [];
    globalThis.fetch = vi.fn(async (input: unknown, init?: { body?: string }) => {
      const url = String(input);
      if (url.includes('/api/org/register')) {
        calls.push({ url, body: init?.body ?? '' });
        return new Response(JSON.stringify({ slug: 'acme-org' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    renderView();
    fireEvent.submit(screen.getByTestId('rjsf-shim'));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(calls).toHaveLength(0);

    act(() => {
      capturedGateProps?.onAccept();
    });

    await waitFor(() => expect(calls).toHaveLength(1));
    const body = JSON.parse(calls[0]!.body) as { consent?: Record<string, unknown> };
    expect(body.consent).toMatchObject({ value: true });
    expect(body.consent?.['given_at']).toBeDefined();
    expect(body.consent?.['valid_till']).toBeDefined();
  });

  it('when the consent copy failed to load, submitting shows a visible error and posts nothing', async () => {
    const registerCalls: string[] = [];
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/api/org/register')) registerCalls.push(url);
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    renderView({ orgConsentContent: null });
    fireEvent.submit(screen.getByTestId('rjsf-shim'));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(messages.register.consent.load_failed_title)).toBeInTheDocument();
    expect(screen.getByText(messages.register.consent.load_failed_detail)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(registerCalls).toHaveLength(0);
  });
});
