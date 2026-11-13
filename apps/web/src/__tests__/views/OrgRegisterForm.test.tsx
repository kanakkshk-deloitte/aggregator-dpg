/**
 * View test: <OrgRegisterForm /> — parent-org registration form (spec §6.1).
 *
 * RJSF is shimmed to a deterministic <form> the same way RegisterView.test.tsx
 * does, so these tests exercise OrgRegisterForm's own submit/error/success
 * logic rather than RJSF's rendering. The consent gate's own scroll-to-unlock
 * mechanics are covered by ConsentGate.test.tsx; here it is shimmed to a plain
 * dialog with an Accept button, for the same reason RJSF is shimmed — these
 * tests exercise OrgRegisterForm's wiring, not the gate's internals.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import messages from '@/i18n/messages/en.json';

// jsdom does not implement scrollIntoView; the error banner's focus effect
// (`useRegistrationFormState`) calls it on every error transition.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

let capturedOnError: ((errs: unknown[]) => void) | undefined;

vi.mock('@/components/forms/RjsfThemed', () => ({
  RjsfThemedForm: ({
    onSubmit,
    onError,
    children,
  }: {
    onSubmit: (e: { formData: Record<string, unknown> }, ev: unknown) => void;
    onError?: (errs: unknown[]) => void;
    children?: ReactNode;
  }) => {
    capturedOnError = onError;
    return (
      <form
        data-testid="rjsf-shim"
        onSubmit={(ev) => {
          ev.preventDefault();
          onSubmit({ formData: { display_name: 'Enable India' } }, ev);
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

// Native-select shim for the searchable parent picker so onValueChange is fire-able.
vi.mock('@/components/ui/SearchableSelect', () => ({
  SearchableSelect: ({
    options,
    onValueChange,
    value,
    placeholder,
  }: {
    options: { value: string; label: string; hint?: string | null }[];
    onValueChange: (v: string) => void;
    value: string;
    placeholder: string;
  }) => (
    <select
      data-testid="parent-select"
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
    >
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.hint ? `${o.label} (${o.hint})` : o.label}
        </option>
      ))}
    </select>
  ),
}));

import { OrgRegisterForm } from '@/app/(public)/register/OrgRegisterForm';

const PARENTS = [
  {
    id: 'p-root',
    name: 'Blue Dots',
    is_root: true,
    known_as_name: null,
    child_known_as_name: 'State',
  },
  {
    id: 'p-state',
    name: 'State Org',
    is_root: false,
    known_as_name: 'State',
    child_known_as_name: 'District',
  },
  {
    id: 'p-plain',
    name: 'Plain Org',
    is_root: false,
    known_as_name: null,
    child_known_as_name: null,
  },
];

const orgSchema = {
  title: 'Organisation Registration',
  type: 'object',
  properties: { display_name: { type: 'string', title: 'Display Name' } },
} as never;

// Present in most tests so the gate has something to show; the
// "consent copy unavailable" test overrides it back to `undefined`.
const consentContentFixture = {
  terms: { version: 1, title: 'Terms', content: 'Terms body' },
  privacy: { version: 1, title: 'Privacy', content: 'Privacy body' },
};

/** Renders the form; the parent list is pre-loaded unless `parents: null` (then it is fetched). */
function renderForm(
  props: Record<string, unknown> = {},
  parents: typeof PARENTS | null = PARENTS,
  accepting = true,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (parents) client.setQueryData(['org-parents'], { accepting, parents });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={messages}>
        <OrgRegisterForm
          schema={orgSchema}
          uiSchema={{}}
          consentContent={consentContentFixture}
          {...props}
        />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

function pickParent(id = 'p-root') {
  fireEvent.change(screen.getByTestId('parent-select'), { target: { value: id } });
}

/** Picks a parent, opens via submit, then accepts the (shimmed) gate. */
async function submitAndAcceptGate(parentId = 'p-root') {
  pickParent(parentId);
  fireEvent.submit(screen.getByTestId('rjsf-shim'));
  await screen.findByRole('dialog');
  act(() => {
    capturedGateProps?.onAccept();
  });
}

describe('<OrgRegisterForm />', () => {
  let originalFetch: typeof fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    capturedOnError = undefined;
    capturedGateProps = undefined;
    vi.restoreAllMocks();
  });

  it('submits to /api/org/register and shows the success panel with the slug', async () => {
    originalFetch = globalThis.fetch;
    const calls: { url: string; body: string }[] = [];
    globalThis.fetch = vi.fn(async (input: unknown, init?: { body?: string }) => {
      calls.push({ url: String(input), body: init?.body ?? '' });
      return new Response(JSON.stringify({ slug: 'enable-india-ab12' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    renderForm();
    await submitAndAcceptGate();

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.url).toBe('/api/org/register');
    const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    expect(body['display_name']).toBe('Enable India');
    expect(body['consent']).toMatchObject({ value: true });
    expect(body['parent_id']).toBe('p-root');

    expect(await screen.findByText('enable-india-ab12')).toBeInTheDocument();
    expect(screen.getByText(messages.register.org_success_heading)).toBeInTheDocument();
  });

  it('shows the ALREADY-REGISTERED panel when the API reports status active', async () => {
    // The API returns 200 for both a new pending registration and an
    // already-approved org whose invite link was re-sent. Rendering "our team
    // will review your organisation" over the second is simply false.
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ slug: 'org1-2ab4', status: 'active', mail_sent: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;

    renderForm();
    await submitAndAcceptGate();

    expect(await screen.findByText(messages.register.org_exists_heading)).toBeInTheDocument();
    expect(screen.getByText(messages.register.org_exists_link_sent)).toBeInTheDocument();
    // The pending copy must NOT appear — that was the reported bug.
    expect(screen.queryByText(messages.register.org_success_review)).not.toBeInTheDocument();
    expect(screen.queryByText(messages.register.org_success_heading)).not.toBeInTheDocument();
  });

  it('tells the owner the mail failed rather than claiming it was sent', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ slug: 'org1-2ab4', status: 'active', mail_sent: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;

    renderForm();
    await submitAndAcceptGate();

    expect(await screen.findByText(messages.register.org_exists_mail_failed)).toBeInTheDocument();
    expect(screen.queryByText(messages.register.org_exists_link_sent)).not.toBeInTheDocument();
  });

  it('shows the error banner on a non-2xx response', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { title: 'Duplicate', detail: 'Org already exists' } }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        ),
    ) as unknown as typeof fetch;

    renderForm();
    await submitAndAcceptGate();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Duplicate')).toBeInTheDocument();
    expect(screen.getByText('Org already exists')).toBeInTheDocument();
  });

  it('shows a network-error banner when fetch throws', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;

    renderForm();
    await submitAndAcceptGate();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Network error')).toBeInTheDocument();
    expect(screen.getByText('offline')).toBeInTheDocument();
  });

  it('leaves field errors to the fields, with no banner', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    renderForm();

    // RjsfThemedForm shim captured onError — invoke it directly to simulate
    // RJSF surfacing a client-validation failure before submit fires.
    act(() => {
      capturedOnError?.([{ property: '.display_name', message: 'is required', name: 'required' }]);
    });

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(messages.register.validation_error_title)).toBeNull();
  });

  it('passes consentContent through formContext without crashing when omitted', () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    renderForm({ consentContent: undefined });
    expect(screen.getByTestId('rjsf-shim')).toBeInTheDocument();
  });

  it('when the consent copy failed to load, submitting shows a visible error and posts nothing', async () => {
    originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    // `consentContent: undefined` mirrors loadConsentConfig failing at boot —
    // `toConsentDocs(undefined)` returns `[]`, so the gate would have nothing
    // to show. Without the fix this is a dead Submit button: no gate, no
    // error, no way for the user to tell what happened.
    renderForm({ consentContent: undefined });
    pickParent();
    fireEvent.submit(screen.getByTestId('rjsf-shim'));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(messages.register.consent.load_failed_title)).toBeInTheDocument();
    expect(screen.getByText(messages.register.consent.load_failed_detail)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  describe('parent organisation', () => {
    it('lists the root as top level and names the others with their known-as name', () => {
      originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn() as unknown as typeof fetch;
      renderForm();
      expect(screen.getByRole('option', { name: 'Blue Dots (Top level)' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'State Org (State)' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'Plain Org' })).toBeInTheDocument();
    });

    it('sends the picked parent', async () => {
      originalFetch = globalThis.fetch;
      const bodies: Record<string, unknown>[] = [];
      globalThis.fetch = vi.fn(async (_input: unknown, init?: { body?: string }) => {
        bodies.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
        return new Response(JSON.stringify({ slug: 's' }), { status: 201 });
      }) as unknown as typeof fetch;
      renderForm();
      await submitAndAcceptGate('p-state');
      await waitFor(() => expect(bodies).toHaveLength(1));
      expect(bodies[0]?.['parent_id']).toBe('p-state');
    });

    it('tells the registrant what the new org will be known as', () => {
      originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn() as unknown as typeof fetch;
      renderForm();
      expect(screen.queryByText(/will be known as/)).toBeNull();
      pickParent('p-state');
      expect(screen.getByText('Your organisation will be known as District.')).toBeInTheDocument();
      pickParent('p-plain');
      expect(screen.queryByText(/will be known as/)).toBeNull();
    });

    it('keeps submit clickable before a parent is picked, so a click can say what is missing', () => {
      originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn() as unknown as typeof fetch;
      renderForm();
      const submit = screen.getByRole('button', { name: messages.register.org_submit });
      expect(submit).toBeEnabled();
    });

    it('refuses a submit without a parent: error shown, no gate, nothing posted', async () => {
      originalFetch = globalThis.fetch;
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as unknown as typeof fetch;
      renderForm();
      fireEvent.submit(screen.getByTestId('rjsf-shim'));
      expect(await screen.findByRole('alert')).toBeInTheDocument();
      expect(screen.getByText(messages.register.parent_selector_required)).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('shows an error with a working retry when the list fails to load', async () => {
      originalFetch = globalThis.fetch;
      let attempt = 0;
      globalThis.fetch = vi.fn(async () => {
        attempt += 1;
        return attempt === 1
          ? new Response(JSON.stringify({ error: { code: 'DB_UNAVAILABLE' } }), { status: 503 })
          : new Response(JSON.stringify({ accepting: true, parents: PARENTS }), { status: 200 });
      }) as unknown as typeof fetch;
      renderForm({}, null);
      expect(await screen.findByText(messages.register.parent_selector_error)).toBeInTheDocument();
      fireEvent.click(screen.getByText(messages.register.org_selector_retry));
      expect(await screen.findByRole('option', { name: 'State Org (State)' })).toBeInTheDocument();
    });

    it('shows the picker and sends the parent when one org below the root is the only option', async () => {
      originalFetch = globalThis.fetch;
      const bodies: Record<string, unknown>[] = [];
      globalThis.fetch = vi.fn(async (_input: unknown, init?: { body?: string }) => {
        bodies.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
        return new Response(JSON.stringify({ slug: 's' }), { status: 201 });
      }) as unknown as typeof fetch;
      renderForm({}, [PARENTS[1]!]);
      expect(screen.getByRole('option', { name: 'State Org (State)' })).toBeInTheDocument();
      await submitAndAcceptGate('p-state');
      await waitFor(() => expect(bodies).toHaveLength(1));
      expect(bodies[0]?.['parent_id']).toBe('p-state');
    });

    it('hides the picker when only the root is listed and sends no parent', async () => {
      originalFetch = globalThis.fetch;
      const bodies: Record<string, unknown>[] = [];
      globalThis.fetch = vi.fn(async (_input: unknown, init?: { body?: string }) => {
        bodies.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
        return new Response(JSON.stringify({ slug: 's' }), { status: 201 });
      }) as unknown as typeof fetch;
      renderForm({}, [PARENTS[0]!]);
      expect(screen.queryByTestId('parent-select')).toBeNull();
      expect(screen.getByText('Your organisation will be known as State.')).toBeInTheDocument();
      fireEvent.submit(screen.getByTestId('rjsf-shim'));
      await screen.findByRole('dialog');
      act(() => {
        capturedGateProps?.onAccept();
      });
      await waitFor(() => expect(bodies).toHaveLength(1));
      expect(bodies[0]).not.toHaveProperty('parent_id');
    });
  });

  describe('registrations closed', () => {
    it('shows the closed message and no submit button', () => {
      originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn() as unknown as typeof fetch;
      renderForm({}, PARENTS, false);
      expect(screen.getByText(messages.register.closed_title)).toBeInTheDocument();
      expect(screen.getByText(messages.register.closed_detail)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: messages.register.org_submit })).toBeNull();
      expect(screen.queryByTestId('rjsf-shim')).toBeNull();
    });
  });

  describe('hierarchy errors', () => {
    it.each([
      ['ORG_DEPTH_LIMIT', 409, undefined, messages.register.org_error_depth_limit],
      ['ORG_CHILD_LIMIT', 409, { parent_id: 'p-state' }, messages.register.org_error_child_limit],
      ['ORG_TOTAL_LIMIT', 409, undefined, messages.register.org_error_total_limit],
      ['CONFLICT', 409, undefined, messages.register.org_error_conflict],
      ['SCHEMA_VALIDATION', 400, { parent_id: 'invalid' }, messages.register.org_error_parent],
    ])('shows a message for %s', async (code, status, fields, text) => {
      originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { code, title: 'Upstream title', detail: 'x', fields } }),
            { status, headers: { 'content-type': 'application/json' } },
          ),
      ) as unknown as typeof fetch;
      renderForm();
      await submitAndAcceptGate('p-state');
      expect(await screen.findByRole('alert')).toBeInTheDocument();
      expect(screen.getByText(text)).toBeInTheDocument();
      expect(screen.queryByText('Upstream title')).toBeNull();
    });

    it('keeps the API message for other schema errors', async () => {
      originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: 'SCHEMA_VALIDATION',
                title: 'Invalid request',
                detail: 'd',
                fields: { email: 'invalid' },
              },
            }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          ),
      ) as unknown as typeof fetch;
      renderForm();
      await submitAndAcceptGate('p-state');
      expect(await screen.findByText('Invalid request')).toBeInTheDocument();
    });
  });
});
