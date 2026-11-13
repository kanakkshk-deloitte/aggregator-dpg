/**
 * Server Component test: `(console)/console/coordinators` — the Invite
 * coordinators button beside the status filter (#873). The button replaces
 * the old sidebar entry, so it must be gated the same way `canInvite` gated
 * that entry: offered to an org owner who manages a real organisation (or
 * holds `org.manage` in the root), withheld from a network admin who only
 * has the read-only `network.administer` view.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import type {
  MeOrg,
  MeResponse,
  UserSearchResponse,
} from '@aggregator-dpg/shared-primitives/user-org';

vi.mock('@/lib/console-actor', () => ({ getConsoleActor: vi.fn() }));
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NOT_FOUND');
  }),
}));
vi.mock('@/lib/console-api.server', () => ({
  consoleRead: vi.fn(),
  consoleReadOptional: vi.fn(),
}));
vi.mock('@/lib/console-domains.server', () => ({
  networkDomains: vi.fn(async () => []),
  servedDomains: vi.fn(() => []),
}));
vi.mock('@/lib/console-hierarchy.server', () => ({ readReachableOrgs: vi.fn(async () => []) }));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (key: string) => `console.${key}`),
}));
vi.mock('@/components/shell/Topbar', () => ({
  Topbar: ({ title, subtitle }: { title: string; subtitle?: string }) => (
    <header>
      <h1>{title}</h1>
      <p>{subtitle}</p>
    </header>
  ),
}));

import ConsoleCoordinatorsPage from '@/app/(console)/console/coordinators/page';
import { getConsoleActor } from '@/lib/console-actor';
import { consoleRead } from '@/lib/console-api.server';
import { networkDomains } from '@/lib/console-domains.server';
import { readReachableOrgs } from '@/lib/console-hierarchy.server';
import type { OrgSearchResponse, User } from '@aggregator-dpg/shared-primitives/user-org';

const org = (over: Partial<MeOrg>): MeOrg => ({
  id: 'org-1',
  name: 'Real Org',
  slug: 'real-org',
  org_type: 'aggregator',
  role: 'owner',
  is_default: false,
  capabilities: ['org.manage'],
  ...over,
});

const me = (over: Partial<MeResponse>): MeResponse => ({
  kind: 'admin',
  user: { id: 'u', contact: { name: null, email: 'a@a.org', phone: null } },
  orgs: [],
  is_network_admin: false,
  ...over,
});

const emptyPage: UserSearchResponse = { users: [], next_cursor: null };

const show = (el: Awaited<ReturnType<typeof ConsoleCoordinatorsPage>>) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {el}
    </NextIntlClientProvider>,
  );

const renderPage = () => ConsoleCoordinatorsPage({ searchParams: Promise.resolve({}) });

describe('console coordinators page — invite button', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(consoleRead).mockResolvedValue(emptyPage);
  });

  it('offers Invite to an org owner managing a real organisation', async () => {
    vi.mocked(getConsoleActor).mockResolvedValue({ ok: true, me: me({ orgs: [org({})] }) });
    show(await renderPage());
    const link = screen.getByRole('link', { name: /console\.nav\.invite/ });
    expect(link).toHaveAttribute('href', '/console/invite');
  });

  it('has no users page for the network admin', async () => {
    vi.mocked(getConsoleActor).mockResolvedValue({
      ok: true,
      me: me({
        is_network_admin: true,
        capabilities: ['network.administer', 'org.manage'],
        orgs: [org({ org_type: 'network_facilitator', capabilities: ['network.administer'] })],
      }),
    });
    await expect(renderPage()).rejects.toThrow('NOT_FOUND');
    expect(consoleRead).not.toHaveBeenCalled();
  });

  it('offers Invite to everyone when access control is off', async () => {
    vi.mocked(getConsoleActor).mockResolvedValue({ ok: true, me: me({ capabilities: null }) });
    show(await renderPage());
    expect(screen.getByRole('link', { name: /console\.nav\.invite/ })).toBeInTheDocument();
  });

  it('shows no Invite button when the actor cannot be read', async () => {
    vi.mocked(getConsoleActor).mockResolvedValue({ ok: false, reason: 'unavailable' });
    show(await renderPage());
    expect(screen.queryByRole('link', { name: /console\.nav\.invite/ })).not.toBeInTheDocument();
  });
});

type OrgRow = OrgSearchResponse['orgs'][number];

const orgRow = (id: string, name: string, over: Partial<OrgRow> = {}): OrgRow => ({
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
  known_as: 'district',
  known_as_name: 'District',
  depth: 2,
  parent_id: null,
  parent_name: null,
  created_at: 't',
  updated_at: 't',
  coordinator_count: 0,
  child_count: 0,
  pending_count: 0,
  ...over,
});

const ORG_K = '00000000-0000-4000-8000-0000000000a1';
const ORG_M = '00000000-0000-4000-8000-0000000000a2';

const coordinatorRow = (over: Partial<User>): User => ({
  id: 'c1',
  user_type: 'coordinator',
  status: 'active',
  name: 'Mysuru',
  contact: { name: 'Asha', email: 'asha@x.org', phone: null },
  serves: [],
  org_id: ORG_M,
  invited: false,
  created_at: 't',
  updated_at: 't',
  rejected_at: null,
  roles: null,
  ...over,
});

describe('console coordinators page — filters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The viewer owns both organisations; users are visible only in owned orgs.
    vi.mocked(getConsoleActor).mockResolvedValue({
      ok: true,
      me: me({
        orgs: [org({ id: ORG_K, name: 'Karnataka' }), org({ id: ORG_M, name: 'Mysuru' })],
      }),
    });
    vi.mocked(consoleRead).mockResolvedValue(emptyPage);
    vi.mocked(readReachableOrgs).mockResolvedValue([
      orgRow(ORG_K, 'Karnataka', { known_as: 'state', known_as_name: 'State', depth: 1 }),
      orgRow(ORG_M, 'Mysuru', { parent_id: ORG_K, parent_name: 'Karnataka' }),
    ]);
    vi.mocked(networkDomains).mockResolvedValue([{ id: 'seeker', label: 'Seeker' }]);
  });

  const renderWith = (params: Record<string, string>) =>
    ConsoleCoordinatorsPage({ searchParams: Promise.resolve(params) });

  it('counts coordinators by status, exactly from the organisations where it can', async () => {
    vi.mocked(readReachableOrgs).mockResolvedValue([
      orgRow(ORG_K, 'Karnataka', { coordinator_count: 7, pending_count: 2 }),
      orgRow(ORG_M, 'Mysuru', { coordinator_count: 3, pending_count: 0 }),
    ]);
    show(await renderWith({}));
    const all = screen.getByRole('link', { name: /console\.org_home\.tile\.all\.label\s*10/ });
    expect(all).toHaveAttribute('href', '/console/coordinators');
    const pending = screen.getByRole('link', {
      name: /console\.org_home\.tile\.pending\.label\s*2/,
    });
    expect(pending).toHaveAttribute('href', '/console/coordinators?status=pending');
    expect(consoleRead).toHaveBeenCalledWith('/v1/user/search', {
      filter: { status: 'active' },
      limit: 100,
    });
  });

  it('leaves a child org the viewer only views out of the counts and the filter', async () => {
    vi.mocked(getConsoleActor).mockResolvedValue({
      ok: true,
      me: me({ orgs: [org({ id: ORG_K, name: 'Karnataka' })] }),
    });
    vi.mocked(readReachableOrgs).mockResolvedValue([
      orgRow(ORG_K, 'Karnataka', { coordinator_count: 7, pending_count: 2 }),
      orgRow(ORG_M, 'Mysuru', { parent_id: ORG_K, coordinator_count: 3, pending_count: 1 }),
    ]);
    show(await renderWith({}));
    expect(
      screen.getByRole('link', { name: /console\.org_home\.tile\.all\.label\s*7/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /console\.org_home\.tile\.pending\.label\s*2/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Mysuru/ })).toBeNull();
  });

  it('marks the status filter in use among the counts', async () => {
    show(await renderWith({ status: 'inactive', org_id: ORG_M }));
    const rejected = screen.getByRole('link', { name: /console\.org_home\.tile\.inactive\.label/ });
    expect(rejected).toHaveAttribute(
      'href',
      `/console/coordinators?org_id=${ORG_M}&status=inactive`,
    );
    expect(rejected.className).toContain('border-rose-500');
  });

  it('lists organisations in tree order with their path and label', async () => {
    show(await renderWith({}));
    const options = screen
      .getAllByRole('option')
      .map((o) => o.textContent)
      .filter((t) => t?.includes('Karnataka'));
    expect(options).toEqual(['Karnataka (State)', 'Karnataka › Mysuru (District)']);
  });

  it('sends the organisation, status and domain filters to the API', async () => {
    await renderWith({ org_id: ORG_M, status: 'pending', serves: 'seeker' });
    expect(consoleRead).toHaveBeenCalledWith('/v1/user/search', {
      filter: { status: 'pending', org_id: ORG_M, serves: 'seeker' },
      limit: 50,
    });
  });

  it('starts the coordinator search without waiting for the organisation list', async () => {
    let release: (orgs: OrgRow[]) => void = () => {};
    vi.mocked(readReachableOrgs).mockReturnValue(new Promise((r) => (release = r)));
    const pending = renderWith({});
    await vi.waitFor(() =>
      expect(consoleRead).toHaveBeenCalledWith('/v1/user/search', { filter: {}, limit: 50 }),
    );
    release([]);
    await pending;
  });

  it('drops a domain the network does not have', async () => {
    await renderWith({ serves: 'nope' });
    expect(consoleRead).toHaveBeenCalledWith('/v1/user/search', { filter: {}, limit: 50 });
  });

  it('shows a chip per active filter that removes only that filter', async () => {
    show(await renderWith({ org_id: ORG_M, serves: 'seeker' }));
    expect(screen.getAllByRole('link', { name: /coordinators\.clear_filter/ })).toHaveLength(2);
    const hrefs = screen
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'))
      .filter((h) => h?.startsWith('/console/coordinators'));
    expect(hrefs).toContain('/console/coordinators?serves=seeker');
    expect(hrefs).toContain(`/console/coordinators?org_id=${ORG_M}`);
    expect(hrefs).toContain('/console/coordinators');
    expect(screen.getByText('Mysuru', { selector: '.font-semibold' })).toBeInTheDocument();
  });

  it('shows no chips without filters', async () => {
    show(await renderWith({}));
    expect(screen.queryByText('console.coordinators.clear_all')).toBeNull();
  });

  it("names the coordinator's organisation with its label, without the registered name", async () => {
    vi.mocked(consoleRead).mockResolvedValue({
      users: [coordinatorRow({}), coordinatorRow({ id: 'c2', name: 'Asha Skills', org_id: ORG_K })],
      next_cursor: null,
    });
    show(await renderWith({}));
    const mysuru = screen.getAllByRole('link', { name: 'Mysuru' })[0]!;
    expect(mysuru).toHaveAttribute('href', `/console/orgs/${ORG_M}`);
    expect(screen.queryByText('console.coordinators.registered_as')).toBeNull();
  });
});
