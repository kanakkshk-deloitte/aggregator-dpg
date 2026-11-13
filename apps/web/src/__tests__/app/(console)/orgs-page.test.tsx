/**
 * Server Component test: `(console)/console/orgs` for the network admin. The
 * page reads the hierarchy with `fields=known_as_values`, so the hierarchy
 * settings get the network's "known as" values.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type {
  KnownAsValues,
  MeResponse,
  OrgHierarchyResponse,
} from '@aggregator-dpg/shared-primitives/user-org';

vi.mock('@/lib/console-actor', () => ({ getConsoleActor: vi.fn() }));
vi.mock('@/lib/console-api.server', () => ({ consoleRead: vi.fn() }));
vi.mock('@/lib/console-hierarchy.server', () => ({
  readNetworkOrgs: vi.fn(async () => ({ orgs: [], more: false })),
  readReachableOrgs: vi.fn(async () => []),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (key: string) => `console.${key}`),
}));
vi.mock('@/components/shell/Topbar', () => ({
  Topbar: ({ title }: { title: React.ReactNode }) => <h1>{title}</h1>,
}));
vi.mock('@/components/console/ConsoleUi', () => ({
  ConsoleCollapsible: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ConsoleSection: ({
    action,
    children,
  }: {
    action?: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <div>
      {action}
      {children}
    </div>
  ),
  EmptyState: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}));
vi.mock('@/components/console/OrgsTable', () => ({ OrgsTable: () => null }));
vi.mock('@/components/console/NetworkOrgsView', () => ({ NetworkOrgsView: () => null }));
vi.mock('@/components/console/ChildOrgsTree', () => ({ ChildOrgsTree: () => null }));
vi.mock('@/components/console/HierarchySettings', () => ({
  HierarchySettings: ({ orgId, values }: { orgId: string; values: KnownAsValues }) => (
    <div data-testid="hierarchy-settings" data-org-id={orgId}>
      {values.map((v) => v.name).join(',')}
    </div>
  ),
}));

import ConsoleOrgsPage from '@/app/(console)/console/orgs/page';
import { getConsoleActor } from '@/lib/console-actor';
import { consoleRead } from '@/lib/console-api.server';
import { readReachableOrgs } from '@/lib/console-hierarchy.server';

const NETWORK_ADMIN: MeResponse = {
  kind: 'admin',
  user: { id: 'na', contact: { name: null, email: 'na@x.org', phone: null } },
  orgs: [],
  is_network_admin: true,
};

const VALUES: KnownAsValues = [{ key: 'state', name: 'State', default: true }];

describe('console orgs page — hierarchy settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getConsoleActor).mockResolvedValue({ ok: true, me: NETWORK_ADMIN } as never);
    vi.mocked(consoleRead).mockImplementation(async (path: string) => {
      if (path === '/v1/org/hierarchy?fields=known_as_values') {
        return {
          network: { id: 'root', name: 'The Network', known_as_values: VALUES },
          limits: { max_depth: 2, max_children: null, max_total_orgs: 50 },
          total_orgs: 0,
        } satisfies OrgHierarchyResponse as never;
      }
      throw new Error(`unexpected read ${path}`);
    });
  });

  it('shows the review box even when nothing is waiting, with where requests appear', async () => {
    render(await ConsoleOrgsPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText(/orgs\.empty_pending.*orgs\.review_hint/)).toBeInTheDocument();
  });

  it("reads the hierarchy with the network's values and passes them to the settings", async () => {
    render(await ConsoleOrgsPage({ searchParams: Promise.resolve({}) }));
    expect(consoleRead).toHaveBeenCalledWith('/v1/org/hierarchy?fields=known_as_values');
    expect(screen.getByTestId('hierarchy-settings')).toHaveTextContent('State');
  });
});

describe('console orgs page — owner view', () => {
  const owner = (role: 'owner' | 'member' = 'owner'): MeResponse => ({
    kind: 'admin',
    user: { id: 'owner', contact: { name: null, email: 'owner@a.org', phone: null } },
    orgs: [
      {
        id: 'a',
        name: 'Org A',
        slug: 'org-a',
        org_type: 'aggregator',
        role,
        is_default: false,
        capabilities: ['org.manage'],
      },
    ],
    is_network_admin: false,
  });

  /** The values Org A defines for its children; null when it cannot have any. */
  function mockOwner(opts: { role?: 'owner' | 'member'; status?: string; values?: unknown } = {}) {
    vi.mocked(getConsoleActor).mockResolvedValue({ ok: true, me: owner(opts.role) } as never);
    vi.mocked(readReachableOrgs).mockResolvedValue([
      { id: 'a', name: 'Org A', parent_id: 'root', status: opts.status ?? 'active', depth: 1 },
    ] as never);
    vi.mocked(consoleRead).mockImplementation(async (path: string) => {
      if (path === '/v1/org/read/a?fields=known_as_values') {
        return {
          org: { id: 'a', known_as_values: opts.values === undefined ? [] : opts.values },
        } as never;
      }
      throw new Error(`unexpected read ${path}`);
    });
  }

  // The owner view is an async server component, resolved here as Next would.
  async function showOwner() {
    const page = (await ConsoleOrgsPage({
      searchParams: Promise.resolve({}),
    })) as React.ReactElement<
      Record<string, unknown>,
      (props: Record<string, unknown>) => Promise<React.ReactElement>
    >;
    render(await page.type(page.props));
  }

  beforeEach(() => vi.clearAllMocks());

  it("links each owned organisation's section to its page", async () => {
    mockOwner();
    await showOwner();
    expect(screen.getByRole('link', { name: 'console.orgs.manage' })).toHaveAttribute(
      'href',
      '/console/orgs/a',
    );
  });

  it('shows the "known as" values editor for an active organisation the viewer owns', async () => {
    mockOwner();
    await showOwner();
    expect(screen.getByTestId('hierarchy-settings')).toHaveAttribute('data-org-id', 'a');
  });

  it('hides the editor when the organisation cannot have child organisations', async () => {
    mockOwner({ values: null });
    await showOwner();
    expect(screen.queryByTestId('hierarchy-settings')).toBeNull();
  });

  it('hides the editor from a member and on a pending organisation, without reading the values', async () => {
    mockOwner({ role: 'member' });
    await showOwner();
    mockOwner({ status: 'pending' });
    await showOwner();
    expect(screen.queryByTestId('hierarchy-settings')).toBeNull();
    expect(consoleRead).not.toHaveBeenCalled();
  });
});
