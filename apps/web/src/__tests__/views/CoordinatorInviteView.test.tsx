/**
 * View test: <CoordinatorInviteView /> — the coordinator invite landing (#701).
 *
 * Covers token decode → org lookup (reusing /api/orgs) → form wiring, plus the
 * invalid / expired / unknown-org fallbacks. The heavy RJSF form is stubbed;
 * this test is about the view's routing + prop wiring, not the form.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import messages from '@/i18n/messages/en.json';

vi.mock('@/hooks/useAggregatorConfig', () => {
  const cfg = { brand: { short_name: 'Test Aggregator' } };
  return {
    useAggregatorConfig: () => ({ data: cfg, isLoading: false }),
    DEFAULT_AGGREGATOR_CONFIG: cfg,
  };
});

// Stub the coordinator form — echo the invite props so we can assert wiring.
vi.mock('@/app/(public)/register/CoordinatorRegisterForm', () => ({
  CoordinatorRegisterForm: (props: {
    inviteToken?: string;
    lockedOrgName?: string;
    lockedEmail?: string;
  }) => (
    <div data-testid="coordinator-form">
      <span data-testid="org">{props.lockedOrgName}</span>
      <span data-testid="email">{props.lockedEmail}</span>
      <span data-testid="token">{props.inviteToken}</span>
    </div>
  ),
}));

import { CoordinatorInviteView } from '@/app/(public)/register/coordinator/CoordinatorInviteView';

const SCHEMA = { title: 'Aggregator Registration', type: 'object' as const };

function makeInvite(claims: { org: string; email: string; exp: number }): string {
  const b64 = btoa(JSON.stringify(claims))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `h.${b64}.s`;
}

function renderView(inviteToken: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={messages}>
        <CoordinatorInviteView schema={SCHEMA} uiSchema={{}} inviteToken={inviteToken} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const PAST = Math.floor(Date.now() / 1000) - 3600;

describe('<CoordinatorInviteView />', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ orgs: [{ id: 'org-1', slug: 'o', display_name: 'JFC' }] }),
      } as Response),
    );
  });
  afterEach(() => vi.clearAllMocks());

  it('decodes the invite, resolves the org name, and wires the form', async () => {
    renderView(makeInvite({ org: 'org-1', email: 'coord@x.org', exp: FUTURE }));
    await waitFor(() => expect(screen.getByTestId('coordinator-form')).toBeInTheDocument());
    expect(screen.getByTestId('org')).toHaveTextContent('JFC');
    expect(screen.getByTestId('email')).toHaveTextContent('coord@x.org');
    expect(screen.getByTestId('token')).not.toBeEmptyDOMElement();
  });

  it('shows an invalid notice for a malformed token', () => {
    renderView('not-a-jwt');
    expect(screen.getByText(/not valid/i)).toBeInTheDocument();
    expect(screen.queryByTestId('coordinator-form')).toBeNull();
  });

  it('shows an expired notice for a past-exp token', () => {
    renderView(makeInvite({ org: 'org-1', email: 'coord@x.org', exp: PAST }));
    expect(screen.getByText(/this invitation has expired/i)).toBeInTheDocument();
    expect(screen.queryByTestId('coordinator-form')).toBeNull();
  });

  it('falls back when the org is not in the active list', async () => {
    renderView(makeInvite({ org: 'org-unknown', email: 'coord@x.org', exp: FUTURE }));
    await waitFor(() => expect(screen.getByText(/can.?t be used/i)).toBeInTheDocument());
    expect(screen.queryByTestId('coordinator-form')).toBeNull();
  });
});
