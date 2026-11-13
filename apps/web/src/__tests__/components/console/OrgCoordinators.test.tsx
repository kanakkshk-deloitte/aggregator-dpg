/**
 * `OrgCoordinators`: the count tiles, the status switch and the search on the
 * owner's organisation home, and the note shown when only part of the list
 * was loaded.
 */
import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import hiMessages from '@/i18n/messages/hi.json';
import { fillTerms } from '@/i18n/terms';
import { OrgCoordinators, type OrgCoordinatorRow } from '@/components/console/OrgCoordinators';

const term = (key: string): string => fillTerms(`[[${key}]]`, 'en');

const rows: OrgCoordinatorRow[] = [
  {
    id: 'u1',
    name: 'Coord One',
    email: 'c1@edge.test',
    organisation: 'Edge Org A',
    status: 'active',
    domains: [
      { id: 'seeker', label: 'Seekers' },
      { id: 'provider', label: 'Providers' },
    ],
  },
  {
    id: 'u2',
    name: 'Asha Rao',
    email: 'asha@edge.test',
    organisation: 'Edge Org A',
    status: 'pending',
    domains: [
      { id: 'seeker', label: 'Seekers' },
      { id: 'provider', label: 'Providers' },
    ],
  },
  {
    id: 'u3',
    name: 'rejected@edge.test',
    email: null,
    organisation: 'Edge Org A',
    status: 'inactive',
    domains: [{ id: 'seeker', label: 'Seekers' }],
  },
];

function renderList(over: Partial<Parameters<typeof OrgCoordinators>[0]> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <OrgCoordinators
        rows={rows}
        total={3}
        pending={1}
        complete
        allHref="/console/coordinators?org_id=org-1"
        {...over}
      />
    </NextIntlClientProvider>,
  );
}

const tile = (label: RegExp) => screen.getByRole('button', { name: label });
const tableRows = () => screen.getAllByRole('row').slice(1);

describe('OrgCoordinators', () => {
  it('shows a count on each tile and every coordinator by default', () => {
    renderList();
    expect(tile(new RegExp(`^${term('Users')}\\s*3`))).toHaveAttribute('aria-pressed', 'true');
    expect(tile(/^Active\s*1\s*Can sign in/)).toBeInTheDocument();
    expect(tile(/^Pending review\s*1\s*Waiting on you/)).toBeInTheDocument();
    expect(tile(/^Rejected\s*1\s*Not approved/)).toBeInTheDocument();
    expect(tableRows()).toHaveLength(3);
    expect(tile(new RegExp(`^${term('Users')}`))).toHaveTextContent('Showing below');
    expect(tile(/^Active\s*1/)).toHaveTextContent('View list');
  });

  it('filters the list from a tile and from the status switch', () => {
    renderList();
    fireEvent.click(tile(/^Rejected\s*1/));
    expect(tableRows()).toHaveLength(1);
    expect(screen.getByText('rejected@edge.test')).toBeInTheDocument();
    const group = screen.getByRole('group', { name: `Show ${term('users')}` });
    fireEvent.click(within(group).getByRole('button', { name: 'Active' }));
    expect(tableRows()).toHaveLength(1);
    expect(screen.getByText('Coord One')).toBeInTheDocument();
    expect(tile(/^Active\s*1/)).toHaveAttribute('aria-pressed', 'true');
  });

  it('searches by name or email, ignoring case', () => {
    renderList();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search name or email' }), {
      target: { value: 'ASHA@' },
    });
    expect(tableRows()).toHaveLength(1);
    expect(screen.getByText('Asha Rao')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'nobody' } });
    expect(screen.getByText(`No ${term('users')} match.`)).toBeInTheDocument();
  });

  it('links each name, Review for a pending coordinator and a view icon for the others', () => {
    renderList();
    expect(screen.getByRole('link', { name: 'Review' })).toHaveAttribute(
      'href',
      '/console/coordinators/u2',
    );
    expect(screen.getByRole('link', { name: 'View Coord One' })).toHaveAttribute(
      'href',
      '/console/coordinators/u1',
    );
    expect(screen.getByRole('link', { name: 'Coord One' })).toHaveAttribute(
      'href',
      '/console/coordinators/u1',
    );
  });

  it('shows each served domain as a chip', () => {
    renderList();
    expect(screen.getAllByText('Seekers')).toHaveLength(3);
    expect(screen.getAllByText('Providers')).toHaveLength(2);
  });

  it('says when nothing is waiting for review', () => {
    renderList({ rows: rows.filter((r) => r.status !== 'pending'), total: 2, pending: 0 });
    expect(tile(/^Pending review\s*0\s*Nothing to review/)).toBeInTheDocument();
    fireEvent.click(tile(/^Pending review/));
    expect(screen.getByText(`No ${term('users')} waiting for review.`)).toBeInTheDocument();
  });

  it('marks counted tiles and links the full list when only part was loaded', () => {
    renderList({ total: 250, pending: 4, complete: false });
    expect(tile(new RegExp(`^${term('Users')}\\s*250`))).toBeInTheDocument();
    expect(tile(/^Pending review\s*4/)).toBeInTheDocument();
    expect(tile(/^Active\s*1\+/)).toBeInTheDocument();
    expect(screen.getByText(/Showing the newest 3\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: `See all ${term('users')}` })).toHaveAttribute(
      'href',
      '/console/coordinators?org_id=org-1',
    );
  });

  it('renders in Hindi when the Hindi catalogue is active', () => {
    render(
      <NextIntlClientProvider locale="hi" messages={hiMessages}>
        <OrgCoordinators rows={rows} total={3} pending={1} complete allHref="/x" />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole('searchbox', { name: 'नाम या ईमेल खोजें' })).toBeInTheDocument();
  });
});
