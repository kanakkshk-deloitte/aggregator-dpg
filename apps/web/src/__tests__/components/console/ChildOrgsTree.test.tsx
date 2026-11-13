/**
 * Unit tests for ChildOrgsTree and buildOrgTree.
 *
 * Covers: building the tree from a flat list (nesting, name order, counts
 * below, a row whose parent is missing), the empty state, the root card,
 * names as links for the network admin and as plain text for an owner,
 * collapsing and expanding a branch, and the "more" note.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import { fillTerms } from '@/i18n/terms';
import type { OrgSearchResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { ChildOrgsTree, buildOrgTree } from '@/components/console/ChildOrgsTree';

const term = (key: string): string => fillTerms(`[[${key}]]`, 'en');

type OrgRow = OrgSearchResponse['orgs'][number];

const STATE = '00000000-0000-4000-8000-0000000000c1';

function row(id: string, name: string, parentId: string, overrides: Partial<OrgRow> = {}): OrgRow {
  return {
    id,
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    name,
    org_type: 'aggregator',
    status: 'active',
    is_default: false,
    url: null,
    locations: [],
    legal_name: null,
    gst_number: null,
    known_as: 'aggregator',
    known_as_name: 'Aggregator',
    depth: 1,
    parent_id: parentId,
    parent_name: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    coordinator_count: 0,
    child_count: 0,
    pending_count: 0,
    ...overrides,
  };
}

const districtB = row('d2', 'District B', STATE, {
  known_as: 'district',
  known_as_name: 'District',
});
const districtA = row('d1', 'District A', STATE, {
  known_as: 'district',
  known_as_name: 'District',
  coordinator_count: 4,
  child_count: 0,
  pending_count: 2,
});
const agg = row('a1', 'Agg One', 'd1', {
  status: 'pending',
  depth: 2,
  known_as: 'old_key',
  known_as_name: null,
});

function renderTree(orgs: OrgRow[], linkRows = false, more = false) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ChildOrgsTree
        rootId={STATE}
        rootName="State Org"
        rootKnownAs="State"
        orgs={orgs}
        linkRows={linkRows}
        more={more}
      />
    </NextIntlClientProvider>,
  );
}

describe('buildOrgTree', () => {
  it('nests each org under its parent, sorted by name, with counts below', () => {
    const tree = buildOrgTree(STATE, [agg, districtB, districtA]);
    expect(tree.map((n) => n.org.name)).toEqual(['District A', 'District B']);
    expect(tree[0]?.children.map((n) => n.org.name)).toEqual(['Agg One']);
    expect(tree.map((n) => n.below)).toEqual([1, 0]);
  });

  it('places a row whose parent is not listed directly under the root', () => {
    const stray = row('s1', 'Stray', 'missing-parent');
    expect(buildOrgTree(STATE, [stray]).map((n) => n.org.name)).toEqual(['Stray']);
  });

  it('returns no nodes for no orgs', () => {
    expect(buildOrgTree(STATE, [])).toEqual([]);
  });
});

describe('<ChildOrgsTree />', () => {
  it('shows the empty state when no org sits below', () => {
    renderTree([]);
    expect(screen.getByText(messages.console.org.children_empty)).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('shows the root card with its label and the total below', () => {
    renderTree([districtA, districtB, agg]);
    expect(screen.getByText('State Org')).toBeInTheDocument();
    expect(screen.getByText('State')).toBeInTheDocument();
    expect(screen.getByText(messages.console.org.children_this)).toBeInTheDocument();
    expect(screen.getByText('3 organisations below')).toBeInTheDocument();
  });

  it('renders each org nested under its parent with its known-as name, depth, status and counts', () => {
    renderTree([districtA, districtB, agg]);
    const districtItem = screen.getByText('District A').closest('li') as HTMLElement;
    expect(within(districtItem).getByText('Agg One')).toBeInTheDocument();
    expect(within(districtItem).getAllByText('District')[0]).toBeInTheDocument();
    expect(within(districtItem).getByText(new RegExp(`4 ${term('users')}`))).toBeInTheDocument();
    expect(within(districtItem).getByText('1 organisation below')).toBeInTheDocument();
    expect(within(districtItem).getAllByText('Level 1')[0]).toBeInTheDocument();
    // A key no longer configured shows the raw key.
    const aggItem = screen.getByText('Agg One').closest('li') as HTMLElement;
    expect(within(aggItem).getByText('old_key')).toBeInTheDocument();
    expect(within(aggItem).getByText('Level 2')).toBeInTheDocument();
    expect(within(aggItem).getByTestId('status-pill')).toHaveTextContent('Pending');
  });

  it('shows names as plain text for an owner', () => {
    renderTree([districtA, agg]);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('links names to the org page for the network admin', () => {
    renderTree([districtA, agg], true);
    expect(screen.getByRole('link', { name: 'Agg One' })).toHaveAttribute(
      'href',
      '/console/orgs/a1',
    );
  });

  it('collapses and expands a branch', () => {
    renderTree([districtA, agg]);
    const toggle = screen.getByRole('button', { name: 'Hide the organisations below District A' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    expect(screen.queryByText('Agg One')).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Show the organisations below District A' }),
    );
    expect(screen.getByText('Agg One')).toBeInTheDocument();
  });

  it('gives a leaf no toggle', () => {
    renderTree([districtB]);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('notes when more orgs exist than are listed', () => {
    renderTree([districtA], false, true);
    expect(screen.getByText(messages.console.org.children_more)).toBeInTheDocument();
  });
});
