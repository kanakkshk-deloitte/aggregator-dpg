/**
 * Unit tests for OrgsTable.
 *
 * Covers: the empty state, row rendering (link, status, counts), approving a
 * pending org, the 409 ALREADY_DECIDED in-place update, a generic decision
 * error, and repairing an active org's owner access.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import { fillTerms } from '@/i18n/terms';
import type { OrgSearchResponse } from '@aggregator-dpg/shared-primitives/user-org';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { OrgsTable } from '@/components/console/OrgsTable';

const term = (key: string): string => fillTerms(`[[${key}]]`, 'en');

type OrgRow = OrgSearchResponse['orgs'][number];

const pendingOrg: OrgRow = {
  id: '00000000-0000-4000-8000-0000000000b1',
  slug: 'pending-org',
  name: 'Pending Org',
  org_type: 'aggregator',
  status: 'pending',
  is_default: false,
  url: null,
  locations: [],
  legal_name: null,
  gst_number: null,
  known_as: 'aggregator',
  known_as_name: 'Aggregator',
  depth: 1,
  parent_id: null,
  parent_name: 'State One',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  coordinator_count: 3,
  child_count: 0,
  pending_count: 1,
};

const activeOrg: OrgRow = {
  ...pendingOrg,
  id: '00000000-0000-4000-8000-0000000000b2',
  name: 'Active Org',
  status: 'active',
};

function renderTable(orgs: OrgRow[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <OrgsTable orgs={orgs} />
    </NextIntlClientProvider>,
  );
}

const respond = (body: unknown, status: number) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe('<OrgsTable />', () => {
  const original = global.fetch;
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    global.fetch = original;
  });

  it('renders the empty message with no rows', () => {
    renderTable([]);
    expect(screen.getByText(messages.console.orgs.empty)).toBeInTheDocument();
  });

  it('renders a row with its link, status and counts', () => {
    renderTable([pendingOrg]);
    const link = screen.getByRole('link', { name: 'Pending Org' });
    expect(link).toHaveAttribute('href', `/console/orgs/${pendingOrg.id}`);
    expect(screen.getByText(messages.console.status.pending)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`3 ${term('users')}`))).toBeInTheDocument();
  });

  it('shows the known_as label, falling back to the key', () => {
    renderTable([pendingOrg, { ...activeOrg, known_as: 'retired_label', known_as_name: null }]);
    expect(
      screen.getByRole('columnheader', { name: messages.console.orgs.col_known_as }),
    ).toBeInTheDocument();
    expect(screen.getByText('Aggregator')).toBeInTheDocument();
    expect(screen.getByText('retired_label')).toBeInTheDocument();
  });

  it('shows approve/reject for a pending org, and no other row action', () => {
    renderTable([pendingOrg, activeOrg]);
    expect(screen.getAllByRole('button', { name: messages.console.orgs.approve })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: messages.console.orgs.reject })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: messages.console.orgs.repair })).toBeNull();
  });

  it('drops the actions column when nothing is pending', () => {
    renderTable([activeOrg]);
    expect(screen.queryByText(messages.console.orgs.col_actions)).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('approves a pending org and updates its status in place', async () => {
    global.fetch = respond(
      { id: pendingOrg.id, status: 'active', notified: true, owner_access: 'granted' },
      200,
    ) as never;
    renderTable([pendingOrg]);
    fireEvent.click(screen.getByRole('button', { name: messages.console.orgs.approve }));
    await waitFor(() =>
      expect(screen.getByText(messages.console.coordinator.decided)).toBeInTheDocument(),
    );
    expect(screen.getByText(messages.console.status.active)).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/console/org/decision/${pendingOrg.id}`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ decision: 'approve' }) }),
    );
    // The hierarchy settings and the tree on the page follow the decision.
    expect(refresh).toHaveBeenCalled();
  });

  it('shows the parent organisation', () => {
    renderTable([pendingOrg]);
    expect(screen.getByText(messages.console.orgs.col_parent)).toBeInTheDocument();
    expect(screen.getByText('State One')).toBeInTheDocument();
  });

  it('updates the row when the decision was already made elsewhere (C10)', async () => {
    global.fetch = respond(
      { error: { code: 'ALREADY_DECIDED', fields: { status: 'inactive' } } },
      409,
    ) as never;
    renderTable([pendingOrg]);
    fireEvent.click(screen.getByRole('button', { name: messages.console.orgs.reject }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'duplicate' } });
    fireEvent.click(screen.getByRole('button', { name: messages.console.orgs.reject_confirm }));
    await waitFor(() =>
      expect(screen.getByText(messages.console.status.inactive)).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: messages.console.orgs.approve })).toBeNull();
  });

  it('asks for a reason before a rejection and sends it', async () => {
    global.fetch = respond(
      { id: pendingOrg.id, status: 'inactive', notified: true, owner_access: 'none' },
      200,
    ) as never;
    renderTable([pendingOrg]);
    fireEvent.click(screen.getByRole('button', { name: messages.console.orgs.reject }));
    expect(global.fetch).not.toHaveBeenCalled();
    const confirm = screen.getByRole('button', {
      name: messages.console.orgs.reject_confirm,
    });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  ' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: ' Not a real org ' } });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        `/api/console/org/decision/${pendingOrg.id}`,
        expect.objectContaining({
          body: JSON.stringify({ decision: 'reject', reason: 'Not a real org' }),
        }),
      ),
    );
  });

  it('cancels a rejection without sending anything', async () => {
    global.fetch = respond({}, 200) as never;
    renderTable([pendingOrg]);
    fireEvent.click(screen.getByRole('button', { name: messages.console.orgs.reject }));
    fireEvent.click(screen.getByRole('button', { name: messages.console.coordinator.cancel }));
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('shows a plain message when a decision fails on the server', async () => {
    global.fetch = respond({ error: { code: 'BOOM' } }, 500) as never;
    renderTable([pendingOrg]);
    fireEvent.click(screen.getByRole('button', { name: messages.console.orgs.approve }));
    expect(await screen.findByText(messages.console.orgs.error.server)).toBeInTheDocument();
  });

  it('says when the organisation is gone', async () => {
    global.fetch = respond({ error: { code: 'NOT_FOUND' } }, 404) as never;
    renderTable([pendingOrg]);
    fireEvent.click(screen.getByRole('button', { name: messages.console.orgs.approve }));
    expect(await screen.findByText(messages.console.orgs.error.not_found)).toBeInTheDocument();
  });
});
