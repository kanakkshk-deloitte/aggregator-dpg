/**
 * Server Component test: `(console)/console/orgs/[id]`. The owner of an active
 * organisation gets the editor for the "known as" values of the organisations
 * under it; the owner of a pending or rejected one, and a viewer who is not
 * the owner, do not. A viewer who picks the org's "known as" value gets the
 * picker, the matching banner, and a details form without that value.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import type {
  MeResponse,
  OrgReadResponse,
  OrgSearchResponse,
} from '@aggregator-dpg/shared-primitives/user-org';

vi.mock('@/lib/console-actor', () => ({ getConsoleActor: vi.fn() }));
vi.mock('@/lib/console-api.server', () => ({
  consoleRead: vi.fn(),
  consoleReadOptional: vi.fn(async () => null),
}));
vi.mock('@/lib/org-schema.server', () => ({ loadOrgSchema: vi.fn(async () => null) }));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (key: string) => `console.${key}`),
  getFormatter: vi.fn(async () => ({ dateTime: () => '1 Jan 2026' })),
}));
vi.mock('@/components/shell/Topbar', () => ({
  Topbar: ({ title, right }: { title: React.ReactNode; right?: React.ReactNode }) => (
    <>
      <h1>{title}</h1>
      {right}
    </>
  ),
}));
vi.mock('@/components/console/OrgEditForm', () => ({
  OrgEditForm: ({ knownAsPicked }: { knownAsPicked?: boolean }) => (
    <div data-testid="org-edit-form" data-known-as-picked={String(knownAsPicked)} />
  ),
}));
vi.mock('@/components/console/KnownAsPicker', () => ({
  KnownAsPicker: ({ parentValues }: { parentValues: unknown }) => (
    <div data-testid="known-as-picker" data-parent-values={JSON.stringify(parentValues)} />
  ),
}));
vi.mock('@/components/console/OrgMoveDialog', () => ({ OrgMoveDialog: () => null }));
vi.mock('@/components/console/ChildOrgsTree', () => ({ ChildOrgsTree: () => null }));
vi.mock('@/components/console/RolesPanel', () => ({ RolesPanel: () => null }));
vi.mock('@/components/console/OwnerAccessRepair', () => ({
  OwnerAccessRepair: () => <div data-testid="owner-access-repair" />,
}));
vi.mock('@/components/console/CopyButton', () => ({ CopyButton: () => null }));
vi.mock('@/components/console/OrgsTable', () => ({
  OrgsTable: ({ orgs }: { orgs: Array<{ id: string }> }) => (
    <div data-testid="org-decision" data-ids={orgs.map((o) => o.id).join(',')} />
  ),
}));
vi.mock('@/components/console/KnownAsValuesEditor', () => ({
  KnownAsValuesEditor: () => <div data-testid="known-as-values-editor" />,
}));

import ConsoleOrgPage from '@/app/(console)/console/orgs/[id]/page';
import { getConsoleActor } from '@/lib/console-actor';
import { consoleRead } from '@/lib/console-api.server';

type Org = OrgReadResponse['org'];

const ORG_ID = '00000000-0000-4000-8000-000000000001';

const org = (over: Partial<Org> = {}): Org =>
  ({
    id: ORG_ID,
    slug: 'alpha',
    name: 'Alpha',
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
    parent_id: 'root',
    parent_name: 'The Network',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  }) as Org;

const me = (userId: string, ownOrgId = ORG_ID): MeResponse => ({
  kind: 'admin',
  user: { id: userId, contact: { name: null, email: 'owner@a.org', phone: null } },
  orgs: [
    {
      id: ownOrgId,
      name: 'Alpha',
      slug: 'alpha',
      org_type: 'aggregator',
      role: 'owner',
      is_default: false,
      capabilities: ['org.manage'],
    },
  ],
  is_network_admin: false,
});

interface PageOptions {
  /** The org the viewer owns. */
  viewerOrgId?: string;
  /** The parent block; null when the viewer does not own the parent. */
  parent?: OrgReadResponse['org']['parent'];
}

function mockPage(target: OrgReadResponse['org'], viewerId = 'owner', opts: PageOptions = {}) {
  vi.mocked(getConsoleActor).mockResolvedValue({
    ok: true,
    me: me(viewerId, opts.viewerOrgId),
  } as never);
  vi.mocked(consoleRead).mockImplementation(async (path: string) => {
    if (path === `/v1/org/read/${ORG_ID}?fields=parent.known_as_values`) {
      return {
        org: {
          ...target,
          parent: opts.parent ?? null,
        },
        owner: { id: 'owner', contact: { name: null, email: 'owner@a.org', phone: null } },
        coordinator_count: 0,
        child_count: 0,
        pending_count: 0,
      } satisfies OrgReadResponse as never;
    }
    if (path === '/v1/org/search') {
      return { orgs: [], next_cursor: null } satisfies OrgSearchResponse as never;
    }
    throw new Error(`unexpected read ${path}`);
  });
}

const show = async () =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {await ConsoleOrgPage({ params: Promise.resolve({ id: ORG_ID }) })}
    </NextIntlClientProvider>,
  );

describe('console org detail — address', () => {
  it('answers not found for an id that is not a UUID, without reading the org', async () => {
    vi.mocked(getConsoleActor).mockResolvedValue({ ok: true, me: me('owner') } as never);
    vi.mocked(consoleRead).mockClear();
    await expect(
      ConsoleOrgPage({ params: Promise.resolve({ id: 'not-an-id' }) }),
    ).rejects.toThrow();
    expect(consoleRead).not.toHaveBeenCalled();
  });
});

describe('console org detail — child organisations', () => {
  beforeEach(() => vi.clearAllMocks());

  it('leaves the "known as" values editor and the child list to the organisations page', async () => {
    mockPage(org());
    await show();
    expect(screen.queryByTestId('known-as-values-editor')).toBeNull();
    expect(screen.queryByRole('heading', { name: /child/i })).toBeNull();
    expect(consoleRead).not.toHaveBeenCalledWith('/v1/org/search', expect.anything());
  });
});

describe('console org detail — "known as" picker', () => {
  beforeEach(() => vi.clearAllMocks());

  const PARENT = {
    id: 'parent',
    name: 'Parent',
    known_as_values: [{ key: 'block', name: 'Block' }],
  };

  it('shows the picker and a details form without the value to the parent owner, with no banner', async () => {
    mockPage(org({ depth: 2 }), 'parent-owner', { viewerOrgId: 'parent', parent: PARENT });
    await show();
    expect(screen.getByTestId('known-as-picker')).toHaveAttribute(
      'data-parent-values',
      JSON.stringify(PARENT.known_as_values),
    );
    expect(screen.queryByText(/viewed_from_above/)).toBeNull();
    expect(screen.getByTestId('org-edit-form')).toHaveAttribute('data-known-as-picked', 'true');
  });

  it("hides a child org's coordinators from the parent owner", async () => {
    mockPage(org({ depth: 2 }), 'parent-owner', { viewerOrgId: 'parent', parent: PARENT });
    await show();
    expect(screen.queryByText('console.org.view_coordinators')).toBeNull();
    expect(screen.queryByText('console.org.tile.coordinators')).toBeNull();
    expect(screen.queryByText('console.org.child_count')).toBeNull();
    expect(screen.queryByText('console.org.children')).toBeNull();
    expect(screen.queryByTestId('org-decision')).toBeNull();
    // The grandchildren are never asked for.
    expect(vi.mocked(consoleRead).mock.calls.map(([path]) => path)).not.toContain('/v1/org/search');
  });

  it('lets the parent owner decide a pending child on its page', async () => {
    mockPage(org({ depth: 2, status: 'pending' }), 'parent-owner', {
      viewerOrgId: 'parent',
      parent: PARENT,
    });
    await show();
    expect(screen.getByTestId('org-decision')).toHaveAttribute('data-ids', ORG_ID);
  });

  it('shows no child-organisations tile on the Default organisation', async () => {
    mockPage(org({ is_default: true }));
    await show();
    expect(screen.queryByText('console.org.child_count')).toBeNull();
  });

  it("shows the owner its own org's coordinators", async () => {
    mockPage(org());
    await show();
    expect(screen.getByText('console.org.view_coordinators')).toBeInTheDocument();
    expect(screen.getByText('console.org.tile.coordinators')).toBeInTheDocument();
    expect(screen.queryByTestId('org-decision')).toBeNull();
  });

  it('keeps the value in the form for a viewer that does not pick it', async () => {
    mockPage(org({ depth: 3 }), 'grandparent-owner', { viewerOrgId: 'grandparent' });
    await show();
    expect(screen.queryByTestId('known-as-picker')).toBeNull();
    expect(screen.getByTestId('org-edit-form')).toHaveAttribute('data-known-as-picked', 'false');
  });

  it('shows the picker when the parent has an empty list', async () => {
    mockPage(org({ depth: 2 }), 'parent-owner', {
      viewerOrgId: 'parent',
      parent: { ...PARENT, known_as_values: [] },
    });
    await show();
    expect(screen.getByTestId('known-as-picker')).toHaveAttribute('data-parent-values', '[]');
  });

  it('hides the picker on the Default organisation even with a parent block', async () => {
    mockPage(org({ is_default: true }), 'parent-owner', { viewerOrgId: 'parent', parent: PARENT });
    await show();
    expect(screen.queryByTestId('known-as-picker')).toBeNull();
    expect(screen.getByTestId('org-edit-form')).toHaveAttribute('data-known-as-picked', 'false');
  });
});

describe('console org detail — repair owner access', () => {
  beforeEach(() => vi.clearAllMocks());

  const PARENT = { id: 'parent', name: 'Parent', known_as_values: [] };

  it("offers repair to the parent's owner on an active child", async () => {
    mockPage(org({ depth: 2 }), 'parent-owner', { viewerOrgId: 'parent', parent: PARENT });
    await show();
    expect(screen.getByTestId('owner-access-repair')).toBeInTheDocument();
  });

  it("does not offer repair to the org's own owner", async () => {
    mockPage(org());
    await show();
    expect(screen.queryByTestId('owner-access-repair')).not.toBeInTheDocument();
  });

  it('does not offer repair on a pending child', async () => {
    mockPage(org({ depth: 2, status: 'pending' }), 'parent-owner', {
      viewerOrgId: 'parent',
      parent: PARENT,
    });
    await show();
    expect(screen.queryByTestId('owner-access-repair')).not.toBeInTheDocument();
  });
});
