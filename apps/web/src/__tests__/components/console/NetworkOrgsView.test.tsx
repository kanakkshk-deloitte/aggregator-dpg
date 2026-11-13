/**
 * `NetworkOrgsView`: the network summary, the
 * status filters, and the organisations as a list with search.
 */
import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import type { OrgSearchResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { NetworkOrgsView } from '@/components/console/NetworkOrgsView';
import { countOrgs } from '@/lib/org-filters';

type Row = OrgSearchResponse['orgs'][number];

const org = (id: string, name: string, over: Partial<Row> = {}): Row => ({
  id,
  slug: id,
  name,
  org_type: 'aggregator',
  status: 'active',
  is_default: false,
  url: null,
  locations: [],
  legal_name: null,
  gst_number: null,
  known_as: null,
  known_as_name: null,
  depth: 1,
  parent_id: 'root',
  parent_name: 'Blue Dots',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  coordinator_count: 3,
  child_count: 0,
  pending_count: 0,
  ...over,
});

const orgs = [
  org('a', 'Edge Org A', { coordinator_count: 54, pending_count: 8, child_count: 1 }),
  org('b', 'Edge Org B', { parent_id: 'a', parent_name: 'Edge Org A', depth: 2 }),
  org('c', 'Cotton Co', { status: 'pending', known_as_name: 'Cluster' }),
  org('d', 'Dropped Org', { status: 'inactive' }),
];

function renderView(props: Partial<Parameters<typeof NetworkOrgsView>[0]> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <NetworkOrgsView rootName="Blue Dots" orgs={orgs} more={false} {...props} />
    </NextIntlClientProvider>,
  );
}

const filter = (name: RegExp) => screen.getByRole('button', { name });
const orgLinks = () =>
  screen.getAllByRole('link').filter((a) => a.getAttribute('href')?.startsWith('/console/orgs/'));

const defaultOrg = org('def', 'Default', { is_default: true, coordinator_count: 2 });

describe('countOrgs', () => {
  it('counts every organisation and each status', () => {
    expect(countOrgs(orgs)).toEqual({ all: 4, active: 2, pending: 1, inactive: 1 });
  });

  it('leaves the Default organisation out, as the organisation limit does', () => {
    expect(countOrgs([...orgs, defaultOrg])).toEqual({
      all: 4,
      active: 2,
      pending: 1,
      inactive: 1,
    });
  });
});

describe('NetworkOrgsView', () => {
  it('lists the Default organisation last, counted in the list but not the tile', () => {
    renderView({ orgs: [defaultOrg, ...orgs] });
    expect(filter(/^All organisations\s*4/)).toHaveTextContent('Default not counted');
    expect(
      screen.getByRole('heading', { level: 2, name: /^Organisations\s*5$/ }),
    ).toBeInTheDocument();
    expect(orgLinks().at(-1)).toHaveTextContent('Default');
    expect(orgLinks().map((a) => a.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('Default')]),
    );
    fireEvent.click(filter(/^Active\s*2/));
    expect(orgLinks().some((a) => a.textContent?.includes('Default'))).toBe(false);
  });

  it('shows the network without an organisation limit bar', () => {
    renderView();
    expect(screen.getAllByText('Blue Dots').length).toBeGreaterThan(0);
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('lists each organisation with its status, opening its page, and no counts', () => {
    renderView();
    expect(orgLinks().map((a) => a.getAttribute('href'))).toEqual([
      '/console/orgs/a',
      '/console/orgs/b',
      '/console/orgs/c',
      '/console/orgs/d',
    ]);
    expect(screen.getByRole('link', { name: /Cotton Co/ })).toHaveTextContent('Cluster');
    expect(screen.getByText(messages.console.orgs.col_joined)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Cotton Co/ })).toHaveTextContent('Jan 1, 2026');
    expect(screen.getByRole('link', { name: /Edge Org A/ })).not.toHaveTextContent('8 pending');
    expect(screen.queryByText(messages.console.orgs.col_counts)).toBeNull();
    expect(screen.queryByText(/^Under /)).toBeNull();
    expect(screen.queryByRole('group', { name: 'Show as' })).toBeNull();
  });

  it('shows no "known as" value for the Default organisation', () => {
    renderView({
      orgs: [...orgs, { ...defaultOrg, known_as: 'aggregator', known_as_name: 'Aggregator' }],
    });
    const row = screen.getByRole('link', { name: /^Default/ });
    expect(row).toHaveTextContent('—');
    expect(row).not.toHaveTextContent('Aggregator');
  });

  it('filters by status from the summary and clears the filter from its chip', () => {
    renderView();
    fireEvent.click(filter(/Pending review\s*1/));
    expect(orgLinks()).toHaveLength(1);
    expect(screen.getByRole('link', { name: /Cotton Co/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: messages.console.orgs.clear_filter }));
    expect(orgLinks()).toHaveLength(4);
  });

  it('searches names and "known as" in the list', () => {
    renderView();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search organisations' }), {
      target: { value: 'cluster' },
    });
    expect(orgLinks()).toHaveLength(1);
    expect(screen.getByRole('link', { name: /Cotton Co/ })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'nothing here' } });
    expect(screen.getByText(messages.console.orgs.empty)).toBeInTheDocument();
  });

  it('says when nothing is waiting for review', () => {
    renderView({ initialFilter: 'pending', orgs: orgs.filter((o) => o.status !== 'pending') });
    expect(screen.getByText(messages.console.orgs.empty_pending)).toBeInTheDocument();
  });
});
