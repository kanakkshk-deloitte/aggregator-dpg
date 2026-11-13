/**
 * View test: <RegisterView /> — coordinator-only flow (#619).
 *
 * As of #619 owner/organisation registration is no longer a tab here (it lives
 * on the `/register/owner` deep link — see OwnerRegisterView.test.tsx). This
 * view is always the single coordinator flow with its org selector (always on
 * since migration 0028) — never tabs.
 *
 * RJSF, the shadcn Select, and useAggregatorConfig are shimmed so the test
 * exercises RegisterView's own logic, not third-party rendering.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import messages from '@/i18n/messages/en.json';

// jsdom does not implement scrollIntoView; the error banner's focus effect
// calls it whenever state transitions to 'error'.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

let capturedOnError: ((errs: unknown[]) => void) | undefined;
let capturedSchema: unknown;

vi.mock('@/components/forms/RjsfThemed', () => ({
  RjsfThemedForm: ({
    schema,
    onSubmit,
    onError,
    children,
  }: {
    schema?: unknown;
    onSubmit: (e: { formData: Record<string, unknown> }, ev: unknown) => void;
    onError?: (errs: unknown[]) => void;
    children?: ReactNode;
  }) => {
    capturedSchema = schema;
    capturedOnError = onError;
    return (
      <form
        data-testid="rjsf-shim"
        onSubmit={(ev) => {
          ev.preventDefault();
          onSubmit({ formData: { name: 'Coord' } }, ev);
        }}
      >
        {children}
      </form>
    );
  },
}));

let capturedGateProps:
  { open: boolean; onAccept: () => void; onCancel?: () => void; agreeLabel?: string } | undefined;

vi.mock('@/components/consent/ConsentGate', () => ({
  ConsentGate: (props: {
    open: boolean;
    onAccept: () => void;
    onCancel?: () => void;
    agreeLabel?: string;
  }) => {
    capturedGateProps = props;
    if (!props.open) return null;
    return (
      <div role="dialog" aria-label="consent-gate-shim">
        <button type="button" onClick={props.onAccept}>
          Accept (shim)
        </button>
        {props.onCancel ? (
          <button type="button" onClick={props.onCancel}>
            Cancel (shim)
          </button>
        ) : null}
      </div>
    );
  },
}));

// Native-select shim for the shadcn Select so onValueChange is fire-able.
vi.mock('@/components/ui/Select', () => ({
  Select: ({
    children,
    onValueChange,
    disabled,
    value,
  }: {
    children?: ReactNode;
    onValueChange?: (v: string) => void;
    disabled?: boolean;
    value?: string;
  }) => (
    <select
      data-testid="org-select"
      disabled={disabled}
      {...(value !== undefined ? { value } : {})}
      onChange={(e) => onValueChange?.(e.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => (
    <option value="">{placeholder}</option>
  ),
  SelectContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children?: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

vi.mock('@/hooks/useAggregatorConfig', () => {
  const cfg = { brand: { short_name: 'Test' }, domains: [{ id: 'seeker', label: 'Seeker' }] };
  return {
    useAggregatorConfig: () => ({ data: cfg, isLoading: false }),
    DEFAULT_AGGREGATOR_CONFIG: cfg,
  };
});

import { RegisterView } from '@/app/(public)/register/RegisterView';

const coordSchema = { title: 'Aggregator Registration', type: 'object', properties: {} } as never;

// Present by default so the consent gate has something to show; the
// "consent copy unavailable" tests override these back to `null`.
const consentContentFixture = {
  terms: { version: 1, title: 'Terms', content: 'Terms body' },
  privacy: { version: 1, title: 'Privacy', content: 'Privacy body' },
};

/** A coordinator schema with the two org-detail fields (0028). */
const orgDetailSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    url: { type: 'string', 'x-org-detail': true },
    locations: { type: 'array', items: { type: 'object' }, 'x-org-detail': true },
  },
};

/** The registration POSTs a fetch spy saw (the org-list fetch is not one). */
/** Answers the organisation list with the single Default org, which the form preselects. */
function withDefaultOrg(spy: (input: unknown, init?: { body?: string }) => Promise<Response>) {
  return (async (input: unknown, init?: { body?: string }) =>
    String(input).includes('/api/orgs')
      ? new Response(
          JSON.stringify({ orgs: [{ id: 'd', slug: 'default', display_name: 'Default' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      : spy(input, init)) as unknown as typeof fetch;
}

function registerPosts(spy: { mock: { calls: unknown[][] } }): unknown[][] {
  return spy.mock.calls.filter((c) => String(c[0]).includes('/api/aggregator/register'));
}

function renderView(props: Record<string, unknown>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={messages}>
        <RegisterView
          schema={coordSchema}
          uiSchema={{}}
          aggregatorConsentContent={consentContentFixture}
          {...props}
        />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

describe('RegisterView coordinator flow', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it('preselects the Default org when it is the only one, and keeps the flat form (0028)', async () => {
    const calls: { url: string; body: string }[] = [];
    globalThis.fetch = vi.fn(async (input: unknown, init?: { body?: string }) => {
      const url = String(input);
      if (url.includes('/api/orgs')) {
        return new Response(
          JSON.stringify({ orgs: [{ id: 'd', slug: 'default', display_name: 'Default' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      calls.push({ url, body: init?.body ?? '' });
      return new Response(JSON.stringify({ aggregator_id: 'agg-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    renderView({ schema: orgDetailSchema });

    const select = (await screen.findByTestId('org-select')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('d'));
    // The Default org has no details of its own: url / locations stay visible.
    const rendered = capturedSchema as { properties?: Record<string, unknown> };
    expect(rendered.properties).toHaveProperty('url');
    fireEvent.submit(screen.getByTestId('rjsf-shim'));
    await screen.findByRole('dialog');
    act(() => {
      capturedGateProps?.onAccept();
    });
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    expect(body).toMatchObject({ org_id: 'd' });
    // The coordinator names its own organisation: never "Default".
    expect(body['name']).not.toBe('Default');
  });

  it('no tabs, and always the coordinator org selector', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ orgs: [{ id: 'o1', slug: 's', display_name: 'Enable India' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ) as unknown as typeof fetch;

    renderView({});

    // #619: owner registration moved off this page — never any tabs.
    expect(screen.queryByRole('tab')).toBeNull();
    expect(await screen.findByTestId('org-select')).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: 'Enable India' })).toBeInTheDocument();
  });

  it('a real org hides the org-detail fields and never submits them (0028)', async () => {
    const calls: { url: string; body: string }[] = [];
    globalThis.fetch = vi.fn(async (input: unknown, init?: { body?: string }) => {
      const url = String(input);
      if (url.includes('/api/orgs')) {
        return new Response(
          JSON.stringify({ orgs: [{ id: 'o1', slug: 's', display_name: 'Enable India' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      calls.push({ url, body: init?.body ?? '' });
      return new Response(JSON.stringify({ aggregator_id: 'agg-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    renderView({ schema: orgDetailSchema });
    await screen.findByRole('option', { name: 'Enable India' });
    fireEvent.change(await screen.findByTestId('org-select'), { target: { value: 'o1' } });
    await waitFor(() =>
      expect(
        (capturedSchema as { properties?: Record<string, unknown> }).properties,
      ).not.toHaveProperty('url'),
    );
    fireEvent.submit(screen.getByTestId('rjsf-shim'));
    await screen.findByRole('dialog');
    act(() => {
      capturedGateProps?.onAccept();
    });
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    expect(body).toMatchObject({ org_id: 'o1', name: 'Enable India' });
    expect(body).not.toHaveProperty('url');
    expect(body).not.toHaveProperty('locations');
  });

  it('forwards the selected org as org_id on coordinator submit', async () => {
    const calls: { url: string; body: string }[] = [];
    globalThis.fetch = vi.fn(async (input: unknown, init?: { body?: string }) => {
      const url = String(input);
      if (url.includes('/api/orgs')) {
        return new Response(
          JSON.stringify({ orgs: [{ id: 'o1', slug: 's', display_name: 'Enable India' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      calls.push({ url, body: init?.body ?? '' });
      return new Response(JSON.stringify({ aggregator_id: 'agg-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    renderView({});

    await screen.findByRole('option', { name: 'Enable India' });
    const select = await screen.findByTestId('org-select');
    fireEvent.change(select, { target: { value: 'o1' } });
    fireEvent.submit(screen.getByTestId('rjsf-shim'));

    await screen.findByRole('dialog');
    act(() => {
      capturedGateProps?.onAccept();
    });

    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    const submitCall = calls.find((c) => c.url.includes('/api/aggregator/register'));
    expect(submitCall).toBeDefined();
    expect(JSON.parse(submitCall!.body)).toMatchObject({ org_id: 'o1', name: 'Enable India' });
  });

  it('shows the org-selector error state with a working retry', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response('boom', { status: 500 });
      return new Response(
        JSON.stringify({ orgs: [{ id: 'o1', slug: 's', display_name: 'Enable India' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    renderView({});

    expect(await screen.findByText(messages.register.org_selector_error)).toBeInTheDocument();
    fireEvent.click(screen.getByText(messages.register.org_selector_retry));

    expect(await screen.findByTestId('org-select')).toBeInTheDocument();
  });

  it('coordinator form: leaves field errors to the fields, with no banner', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('{}', { status: 200 }),
    ) as unknown as typeof fetch;
    renderView({});

    act(() => {
      capturedOnError?.([{ property: '.name', message: 'is required', name: 'required' }]);
    });

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(messages.register.validation_error_title)).toBeNull();
  });
});

describe('RegisterView consent gate', () => {
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
  };

  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it('coordinator: strips the consent block from the schema handed to RJSF', () => {
    globalThis.fetch = vi.fn(
      async () => new Response('{}', { status: 200 }),
    ) as unknown as typeof fetch;

    renderView({ schema: schemaWithConsent });

    const rendered = capturedSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(rendered.properties).not.toHaveProperty('consent');
    expect(rendered.required).not.toContain('consent');
  });

  it('coordinator: submitting opens the gate and posts nothing', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ aggregator_id: 'agg-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    globalThis.fetch = withDefaultOrg(fetchSpy);

    renderView({});
    // The only org (Default) is preselected once the list loads.
    await screen.findByText('Default');
    fireEvent.submit(screen.getByTestId('rjsf-shim'));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(registerPosts(fetchSpy)).toHaveLength(0);
  });

  it('coordinator: cancelling the gate closes it without posting, leaving the form in place', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    globalThis.fetch = withDefaultOrg(fetchSpy);

    renderView({});
    // The only org (Default) is preselected once the list loads.
    await screen.findByText('Default');
    fireEvent.submit(screen.getByTestId('rjsf-shim'));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    act(() => {
      capturedGateProps?.onCancel?.();
    });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(registerPosts(fetchSpy)).toHaveLength(0);
    expect(screen.getByTestId('rjsf-shim')).toBeInTheDocument();
  });

  it('coordinator: accepting the gate posts consent.value:true with both timestamps to /api/aggregator/register', async () => {
    const calls: { url: string; body: string }[] = [];
    const fetchSpy = vi.fn(async (input: unknown, init?: { body?: string }) => {
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
      return new Response(JSON.stringify({ aggregator_id: 'agg-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    globalThis.fetch = withDefaultOrg(fetchSpy);

    renderView({});
    // The only org (Default) is preselected once the list loads.
    await screen.findByText('Default');
    fireEvent.submit(screen.getByTestId('rjsf-shim'));
    await screen.findByRole('dialog');

    act(() => {
      capturedGateProps?.onAccept();
    });

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toContain('/api/aggregator/register');
    const body = JSON.parse(calls[0]!.body) as { consent?: Record<string, unknown> };
    expect(body.consent).toMatchObject({ value: true });
    expect(body.consent?.['given_at']).toBeDefined();
    expect(body.consent?.['valid_till']).toBeDefined();
  });

  it('coordinator: when the consent copy failed to load, submitting shows a visible error and posts nothing', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = withDefaultOrg(fetchSpy);

    renderView({ aggregatorConsentContent: null });
    await screen.findByText('Default');
    fireEvent.submit(screen.getByTestId('rjsf-shim'));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(messages.register.consent.load_failed_title)).toBeInTheDocument();
    expect(screen.getByText(messages.register.consent.load_failed_detail)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(registerPosts(fetchSpy)).toHaveLength(0);
  });
});
