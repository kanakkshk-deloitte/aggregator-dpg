/**
 * View test: <PublicRegistrationView /> — pre-submit lookup branches.
 *
 * RJSF is mocked to a thin shim that exposes its `onSubmit` via a button
 * so each test can fire a submit with whatever form data it wants. The
 * goal here is to exercise the probe → branch → submit pipeline, not the
 * RJSF rendering surface (covered by RJSF's own tests).
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import messages from '@/i18n/messages/en.json';
import type * as UseAggregatorConfigModule from '@/hooks/useAggregatorConfig';

// jsdom does not implement scrollIntoView; the error banner's focus effect
// calls it whenever state transitions to 'error'.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

// Shim RjsfThemedForm: render a deterministic <form>; reads schema defaults
// for the email/name fields to construct a deterministic formData payload
// for onSubmit. Keeps RJSF's render tree out of the test — we exercise the
// lookup/submit pipeline, not RJSF rendering (covered by RJSF's own tests).
vi.mock('@/components/forms/RjsfThemed', () => {
  return {
    RjsfThemedForm: ({
      schema,
      onSubmit,
      children,
    }: {
      schema: { properties?: Record<string, { default?: unknown }> };
      onSubmit: (e: { formData: Record<string, unknown> }, ev: unknown) => void;
      children?: React.ReactNode;
    }) => {
      const formData: Record<string, unknown> = {};
      for (const [field, def] of Object.entries(schema.properties ?? {})) {
        if (def && 'default' in def && def.default !== undefined) {
          formData[field] = def.default;
        }
      }
      return (
        <form
          data-testid="rjsf-shim"
          onSubmit={(ev) => {
            ev.preventDefault();
            onSubmit({ formData }, ev);
          }}
        >
          {children}
        </form>
      );
    },
  };
});

// Shim ConsentGate for the one test that exercises the gate wiring (submit →
// open → accept → resubmit): its own scroll-to-unlock mechanics are covered
// by ConsentGate.test.tsx, so this file only needs to reach in and fire
// `onAccept`. Same shimming approach as OrgRegisterForm.test.tsx.
let capturedGateProps: { open: boolean; onAccept: () => void; onCancel?: () => void } | undefined;

vi.mock('@/components/consent/ConsentGate', () => ({
  ConsentGate: (props: { open: boolean; onAccept: () => void; onCancel?: () => void }) => {
    capturedGateProps = props;
    if (!props.open) return null;
    return <div role="dialog" aria-label="consent-gate-shim" />;
  },
}));

/** Waits for the shimmed gate to open and returns its captured props. */
const gateShim = {
  async opened() {
    await waitFor(() => expect(capturedGateProps?.open).toBe(true));
    return capturedGateProps!;
  },
};

// useAggregatorConfig hits the BFF. We don't need its real behaviour here.
// Most of this file exercises the probe/lookup/submit pipeline, which is
// orthogonal to consent — those tests get a domain that doesn't show the
// consent step at all, so the pipeline behaves exactly as it did before #636
// Task 7 wired the blocking gate in. The two tests that actually exercise the
// U18 / consent branches (`CONSENT_DOMAIN` below) opt in explicitly.
const cfgMock = vi.hoisted(() => ({
  value: undefined as Record<string, unknown> | undefined,
}));
vi.mock('@/hooks/useAggregatorConfig', async (importOriginal) => {
  // DEFAULT_AGGREGATOR_CONFIG must come from the real module, not
  // `cfgMock.value`: a mock factory runs exactly once, so
  // `DEFAULT_AGGREGATOR_CONFIG: cfgMock.value` would snapshot whatever
  // `cfgMock.value` happened to be at that one moment (`undefined`, since
  // that's its initial value) and stay that way for the rest of the file,
  // silently ignoring every later `cfgMock.value = ...` a test makes. No
  // test in this file currently depends on the real fallback shape, but a
  // future one that does (or a shared assumption a reader brings from
  // elsewhere) shouldn't get a mock that looks live but isn't.
  const actual = await importOriginal<typeof UseAggregatorConfigModule>();
  return {
    useAggregatorConfig: () => ({ data: cfgMock.value, isLoading: false }),
    DEFAULT_AGGREGATOR_CONFIG: actual.DEFAULT_AGGREGATOR_CONFIG,
  };
});

const NO_CONSENT_CFG = {
  brand: { short_name: 'Test', primary_color: '#4338ca' },
  domains: [{ id: 'seeker', label: 'Seeker' }],
};

// #613: guardian_consent_required drives the birth-year field; a
// go_live_required with consent_required drives the consent step. Both on
// here so the consent/U18 branches under test render.
const CONSENT_DOMAIN_CFG = {
  brand: { short_name: 'Test', primary_color: '#4338ca' },
  domains: [
    {
      id: 'seeker',
      label: 'Seeker',
      guardian_consent_required: true,
      go_live_required: ['schema_required', 'consent_required'],
    },
  ],
};

beforeEach(() => {
  cfgMock.value = NO_CONSENT_CFG;
  capturedGateProps = undefined;
});

// Pull the view after mocks register.
import { PublicRegistrationView } from '@/app/[org]/[slug]/PublicRegistrationView';

const baseProps = {
  org: 'acme',
  slug: 'winter25',
  network: 'blue_dot',
  domain: 'seeker',
  context: { title: 'Winter 2025 Registration', org_name: 'Acme' },
  schema: {
    type: 'object' as const,
    properties: {
      email: { type: 'string' as const },
      name: { type: 'string' as const },
    },
  },
  uiSchema: {},
  submissionShape: 'account_and_profile' as const,
  publicHintI18nKey: null,
};

function renderView(formData: Record<string, unknown> = { email: 'a@b.com', name: 'A' }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={messages as Record<string, unknown>}>
        <PreloadedView initialData={formData} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

// Wrapper that seeds the view's formData via the schema-injected email
// default. Cleaner than reaching inside the component under test.
function PreloadedView({ initialData }: { initialData: Record<string, unknown> }) {
  const schemaWithDefault = {
    ...baseProps.schema,
    properties: {
      ...baseProps.schema.properties,
      email: { ...baseProps.schema.properties.email, default: initialData['email'] },
      name: { ...baseProps.schema.properties.name, default: initialData['name'] },
    },
  };
  return <PublicRegistrationView {...baseProps} schema={schemaWithDefault} />;
}

describe('<PublicRegistrationView /> — lookup branches', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('shows the owned-elsewhere banner and skips the submit', async () => {
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = input.toString();
      if (url.includes('/lookup')) {
        return new Response(
          JSON.stringify({ user_exists: true, owned_elsewhere: true, lifecycle_summary: null }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    renderView();
    fireEvent.submit(screen.getByTestId('rjsf-shim'));
    expect(await screen.findByTestId('lookup-owned-elsewhere')).toBeInTheDocument();
    // Only the probe — no submit POST followed it.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]!.toString()).toContain('/lookup');
  });

  it('submits on an in-progress draft instead of offering to resume it (#780)', async () => {
    // The "Resume where you left off" prompt is gone. It never resumed
    // anything — its CTA only bypassed the probe, and `onboard()` sends no
    // `item_id`, so signals inserted a new profile exactly as the plain path
    // does. Keeping it also made the form's answer depend on which profile
    // signals listed first: a participant with a live profile and a newer
    // abandoned draft was offered a resume rather than simply registering.
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = input.toString();
      if (url.includes('/lookup')) {
        return new Response(
          JSON.stringify({
            user_exists: true,
            owned_elsewhere: false,
            lifecycle_summary: {
              primary_item: { item_id: 'item-xyz', lifecycle_status: 'draft' },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/submit')) {
        return new Response(JSON.stringify({ outcome: 'passed', submission_id: 'sub-draft' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    renderView();
    fireEvent.submit(screen.getByTestId('rjsf-shim'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect(fetchMock.mock.calls[1]![0]!.toString()).toContain('/submit');
    expect(screen.queryByTestId('lookup-resume')).toBeNull();
  });

  it('passes through to /submit when the probe says allow', async () => {
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = input.toString();
      if (url.includes('/lookup')) {
        return new Response(
          JSON.stringify({ user_exists: false, owned_elsewhere: false, lifecycle_summary: null }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/submit')) {
        return new Response(JSON.stringify({ outcome: 'passed', submission_id: 'sub-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    renderView();
    fireEvent.submit(screen.getByTestId('rjsf-shim'));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect(fetchMock.mock.calls[0]![0]!.toString()).toContain('/lookup');
    expect(fetchMock.mock.calls[1]![0]!.toString()).toContain('/submit');
    expect(
      await screen.findByText(/Registration received|Already registered/i),
    ).toBeInTheDocument();
  });

  it('renders no partial checkbox (flag removed; full form always submits)', async () => {
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = input.toString();
      if (url.includes('/lookup')) {
        return new Response(
          JSON.stringify({ user_exists: false, owned_elsewhere: false, lifecycle_summary: null }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ outcome: 'passed', submission_id: 'sub-2' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    renderView();
    expect(screen.queryByTestId('lookup-partial-checkbox')).toBeNull();
    fireEvent.submit(screen.getByTestId('rjsf-shim'));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    const submitCall = fetchMock.mock.calls[1]!;
    const body = JSON.parse(String((submitCall[1] as RequestInit).body)) as {
      partial?: boolean;
      email?: string;
    };
    expect(body.partial).toBeUndefined();
    expect(body.email).toBe('a@b.com');
  });

  it('omits `partial` from the /submit body', async () => {
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = input.toString();
      if (url.includes('/lookup')) {
        return new Response(
          JSON.stringify({ user_exists: false, owned_elsewhere: false, lifecycle_summary: null }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ outcome: 'passed', submission_id: 's' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    renderView();
    fireEvent.submit(screen.getByTestId('rjsf-shim'));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    const submitCall = fetchMock.mock.calls[1]!;
    const body = JSON.parse(String((submitCall[1] as RequestInit).body)) as {
      partial?: boolean;
    };
    expect(body.partial).toBeUndefined();
  });

  it('probes using the network identity field-map (non-standard phone key)', async () => {
    // Regression: purple_dot-style networks key phone as `mobile_number`,
    // not `phone`. The probe must read the value via the `identity.phone`
    // selector and forward it as `phone_number`, else owned_elsewhere no-ops.
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = input.toString();
      if (url.includes('/lookup')) {
        return new Response(
          JSON.stringify({ user_exists: false, owned_elsewhere: false, lifecycle_summary: null }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ outcome: 'passed', submission_id: 's' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const schema = {
      type: 'object' as const,
      properties: { mobile_number: { type: 'string' as const, default: '+919800000000' } },
    };
    render(
      <QueryClientProvider client={client}>
        <NextIntlClientProvider locale="en" messages={messages as Record<string, unknown>}>
          <PublicRegistrationView
            {...baseProps}
            schema={schema}
            identity={{ name: 'name', phone: 'mobile_number', email: 'email' }}
          />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
    fireEvent.submit(screen.getByTestId('rjsf-shim'));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    const lookupUrl = fetchMock.mock.calls[0]![0]!.toString();
    expect(lookupUrl).toContain('/lookup');
    expect(lookupUrl).toContain('phone_number=%2B919800000000');
  });
});

describe('<PublicRegistrationView /> — remaining branches', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('submits and creates another profile when the participant already has a live one (#780)', async () => {
    // A participant may hold more than one profile. This form used to stop here
    // with an "Already registered" banner, which made it the only onboarding
    // path that refused — bulk upload has always created a second profile for a
    // re-uploaded row. A live primary must now fall straight through to /submit.
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = input.toString();
      if (url.includes('/lookup')) {
        return new Response(
          JSON.stringify({
            user_exists: true,
            owned_elsewhere: false,
            lifecycle_summary: {
              primary_item: { item_id: 'item-1', lifecycle_status: 'live' },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/submit')) {
        return new Response(JSON.stringify({ outcome: 'passed', submission_id: 'sub-780' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    renderView();
    fireEvent.submit(screen.getByTestId('rjsf-shim'));

    // The probe still runs — `owned_elsewhere` and the resume branch depend on
    // it — but a live primary no longer short-circuits it.
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect(fetchMock.mock.calls[0]![0]!.toString()).toContain('/lookup');
    expect(fetchMock.mock.calls[1]![0]!.toString()).toContain('/submit');
    expect(screen.queryByTestId('lookup-already-registered')).toBeNull();
  });

  it('clears the owned-elsewhere banner on "use a different contact" click', async () => {
    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = input.toString();
      if (url.includes('/lookup')) {
        return new Response(
          JSON.stringify({ user_exists: true, owned_elsewhere: true, lifecycle_summary: null }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    renderView();
    fireEvent.submit(screen.getByTestId('rjsf-shim'));
    await screen.findByTestId('lookup-owned-elsewhere');

    fireEvent.click(screen.getByText(messages.profile.public_reg.lookup.owned_elsewhere_cta));
    expect(screen.queryByTestId('lookup-owned-elsewhere')).toBeNull();
  });

  it('shows a server error banner (title/detail/code) on a non-409 failure response', async () => {
    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = input.toString();
      if (url.includes('/lookup')) {
        return new Response(
          JSON.stringify({ user_exists: false, owned_elsewhere: false, lifecycle_summary: null }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({ error: { title: 'Rejected', detail: 'Bad payload', code: 'BAD_INPUT' } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    renderView();
    fireEvent.submit(screen.getByTestId('rjsf-shim'));

    expect(await screen.findByRole('alert')).toHaveTextContent('Rejected');
    expect(screen.getByText('Bad payload')).toBeInTheDocument();
    expect(screen.getByText(/Code: BAD_INPUT/)).toBeInTheDocument();
  });

  it('shows a network-error banner when the /submit fetch throws', async () => {
    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = input.toString();
      if (url.includes('/lookup')) {
        return new Response(
          JSON.stringify({ user_exists: false, owned_elsewhere: false, lifecycle_summary: null }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error('network down');
    }) as unknown as typeof fetch;

    renderView();
    fireEvent.submit(screen.getByTestId('rjsf-shim'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      messages.profile.public_reg.error_network_title,
    );
    expect(screen.getByText('network down')).toBeInTheDocument();
  });

  it('"Register another" resets the done screen back to the form', async () => {
    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = input.toString();
      if (url.includes('/lookup')) {
        return new Response(
          JSON.stringify({ user_exists: false, owned_elsewhere: false, lifecycle_summary: null }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ outcome: 'passed', submission_id: 'sub-done' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    renderView();
    fireEvent.submit(screen.getByTestId('rjsf-shim'));
    await screen.findByText(messages.profile.public_reg.done_passed_title);

    fireEvent.click(screen.getByText(messages.profile.public_reg.btn_register_another));
    expect(screen.getByTestId('rjsf-shim')).toBeInTheDocument();
  });

  it('renders the U18 notice (no consent checkbox) for a minor year of birth and still submits', async () => {
    cfgMock.value = CONSENT_DOMAIN_CFG;
    const currentYear = new Date().getFullYear();
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = input.toString();
      if (url.includes('/lookup')) {
        return new Response(
          JSON.stringify({ user_exists: false, owned_elsewhere: false, lifecycle_summary: null }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ outcome: 'passed', submission_id: 'sub-minor' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    renderView();
    fireEvent.change(screen.getByLabelText(/Year of birth/), {
      target: { value: String(currentYear - 10) },
    });
    expect(screen.getByText(messages.profile.public_reg.u18_notice)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).toBeNull();

    fireEvent.submit(screen.getByTestId('rjsf-shim'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const submitBody = JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body)) as {
      consent_terms?: boolean;
      year_of_birth?: string;
    };
    expect(submitBody.consent_terms).toBe(false);
    expect(submitBody.year_of_birth).toBe(String(currentYear - 10));
  });

  it('adult path opens the gate on submit and sends consent_terms/privacy/profile true on accept', async () => {
    // #636 Task 7: consent no longer comes from an inline checkbox — the
    // adult path now goes through the blocking ConsentGate. The gate's own
    // scroll-to-unlock mechanics are covered by ConsentGate.test.tsx; here we
    // exercise the wiring (submit opens it, accept resubmits with consent
    // true), so ConsentGate is shimmed the same way OrgRegisterForm.test.tsx
    // shims it.
    cfgMock.value = CONSENT_DOMAIN_CFG;
    const currentYear = new Date().getFullYear();
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = input.toString();
      if (url.includes('/lookup')) {
        return new Response(
          JSON.stringify({ user_exists: false, owned_elsewhere: false, lifecycle_summary: null }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ outcome: 'passed', submission_id: 'sub-adult' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <NextIntlClientProvider locale="en" messages={messages as Record<string, unknown>}>
          <PublicRegistrationView
            {...baseProps}
            schema={{
              ...baseProps.schema,
              properties: {
                ...baseProps.schema.properties,
                email: { type: 'string', default: 'a@b.com' },
              },
            }}
            consentContent={{
              terms: { version: 1, title: 'Terms', content: 'Terms body' },
              privacy: { version: 1, title: 'Privacy', content: 'Privacy body' },
              profileCreation: { version: 1, statement: 'Profile statement.' },
            }}
          />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
    fireEvent.change(screen.getByLabelText(/Year of birth/), {
      target: { value: String(currentYear - 30) },
    });
    // No inline checkbox before the gate opens.
    expect(screen.queryByRole('checkbox')).toBeNull();

    fireEvent.submit(screen.getByTestId('rjsf-shim'));
    const gateProps = await gateShim.opened();
    act(() => {
      gateProps.onAccept();
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const submitBody = JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body)) as {
      consent_terms?: boolean;
      consent_privacy?: boolean;
      consent_profile?: boolean;
    };
    expect(submitBody.consent_terms).toBe(true);
    expect(submitBody.consent_privacy).toBe(true);
    expect(submitBody.consent_profile).toBe(true);
  });

  it('renders the MinimalIdentityForm for an account_only link and submits without a profile schema', async () => {
    cfgMock.value = CONSENT_DOMAIN_CFG;
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ outcome: 'passed', submission_id: 'sub-mini' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <NextIntlClientProvider locale="en" messages={messages as Record<string, unknown>}>
          <PublicRegistrationView
            {...baseProps}
            network=""
            submissionShape="account_only"
            identity={{ name: 'name', phone: 'phone', email: 'email' }}
            consentContent={{
              terms: { version: 1, title: 'Terms', content: 'Terms body' },
              privacy: { version: 1, title: 'Privacy', content: 'Privacy body' },
              profileCreation: { version: 1, statement: 'Profile statement.' },
            }}
          />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );

    const currentYear = new Date().getFullYear();
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Quick Signup' } });
    fireEvent.change(screen.getByLabelText(/Year of birth/), {
      target: { value: String(currentYear - 22) },
    });
    fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '9876543210' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Submit/ }));

    // #636 Task 8: this surface is now routed through the same blocking
    // consent gate as the full-profile form (a two-document privacy+terms
    // variant — see PublicRegistrationView.account-only-consent-gate.test.tsx
    // for the tracker-node assertions). Accept it before the /submit POST
    // fires.
    const gateProps = await gateShim.opened();
    act(() => {
      gateProps.onAccept();
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]![0]!.toString()).toContain('/submit');
    const submitBody = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body)) as {
      consent_terms?: boolean;
      consent_privacy?: boolean;
      consent_profile?: boolean;
    };
    expect(submitBody.consent_terms).toBe(true);
    expect(submitBody.consent_privacy).toBe(true);
    expect(submitBody.consent_profile).toBeUndefined();
  });
});
