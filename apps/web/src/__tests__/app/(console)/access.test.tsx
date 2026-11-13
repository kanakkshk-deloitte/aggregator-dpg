/**
 * Server Component tests: `(console)/console/access/{roles,permissions}` —
 * the network admin's read-only roles and permissions view (#871).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import type { MeResponse } from '@aggregator-dpg/shared-primitives/user-org';

vi.mock('@/lib/console-actor', () => ({ getConsoleActor: vi.fn() }));
vi.mock('@/lib/console-api.server', () => ({ consoleReadOptional: vi.fn() }));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (key: string) => `access.${key}`),
}));
vi.mock('@/components/shell/Topbar', () => ({
  Topbar: ({ title, subtitle }: { title: string; subtitle?: string }) => (
    <header>
      <h1>{title}</h1>
      <p>{subtitle}</p>
    </header>
  ),
}));
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NOT_FOUND');
  }),
}));

import RolesPage from '@/app/(console)/console/access/roles/page';
import PermissionsPage from '@/app/(console)/console/access/permissions/page';
import { getConsoleActor } from '@/lib/console-actor';
import { consoleReadOptional } from '@/lib/console-api.server';

const me = (over: Partial<MeResponse>): MeResponse => ({
  kind: 'admin',
  user: { id: 'u', contact: { name: null, email: 'a@a.org', phone: null } },
  orgs: [],
  is_network_admin: false,
  ...over,
});

const show = (el: Awaited<ReturnType<typeof RolesPage>>) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {el}
    </NextIntlClientProvider>,
  );

/** Each endpoint's body, empty: the page shows the list's empty state. */
const bodies: Record<string, unknown> = {
  '/v1/rbac/roles': { roles: [] },
  '/v1/rbac/permissions': { permissions: [] },
};

const pages = [
  ['roles', RolesPage, 'No roles.', messages.console.access.subtitle_roles],
  ['permissions', PermissionsPage, 'No permissions.', messages.console.access.subtitle_permissions],
] as const;

describe.each(pages)('console access %s page', (_name, Page, emptyText, subtitle) => {
  beforeEach(() => vi.clearAllMocks());

  it('is not found for an organisation owner, without reading the API', async () => {
    vi.mocked(getConsoleActor).mockResolvedValue({ ok: true, me: me({ capabilities: null }) });
    await expect(Page()).rejects.toThrow('NOT_FOUND');
    expect(consoleReadOptional).not.toHaveBeenCalled();
  });

  it('is not found for a network admin without network.administer', async () => {
    vi.mocked(getConsoleActor).mockResolvedValue({
      ok: true,
      me: me({ is_network_admin: true, capabilities: ['org.manage'] }),
    });
    await expect(Page()).rejects.toThrow('NOT_FOUND');
  });

  it('shows the table to the network admin', async () => {
    vi.mocked(getConsoleActor).mockResolvedValue({
      ok: true,
      me: me({ is_network_admin: true, capabilities: ['network.administer'] }),
    });
    vi.mocked(consoleReadOptional).mockImplementation(async (path: string) => bodies[path] ?? null);
    show(await Page());
    expect(
      vi
        .mocked(consoleReadOptional)
        .mock.calls.map(([p]) => p)
        .sort(),
    ).toEqual(['/v1/rbac/permissions', '/v1/rbac/roles']);
    expect(screen.getByText(emptyText)).toBeInTheDocument();
    expect(screen.getByText(subtitle)).toBeInTheDocument();
    expect(screen.queryByText('access.off')).not.toBeInTheDocument();
  });

  it('says the view is unavailable when the API cannot answer', async () => {
    vi.mocked(getConsoleActor).mockResolvedValue({
      ok: true,
      me: me({ is_network_admin: true, capabilities: null }),
    });
    vi.mocked(consoleReadOptional).mockResolvedValue(null);
    show(await Page());
    expect(screen.getByText('access.off')).toBeInTheDocument();
  });

  it('says the view is unavailable when only one of the two lists can be read', async () => {
    vi.mocked(getConsoleActor).mockResolvedValue({
      ok: true,
      me: me({ is_network_admin: true, capabilities: null }),
    });
    vi.mocked(consoleReadOptional).mockImplementation(async (path: string) =>
      path === '/v1/rbac/roles' ? bodies[path] : null,
    );
    show(await Page());
    expect(screen.getByText('access.off')).toBeInTheDocument();
  });

  it('renders nothing when the actor cannot be read (the layout handles it)', async () => {
    vi.mocked(getConsoleActor).mockResolvedValue({ ok: false, reason: 'unavailable' });
    expect(await Page()).toBeNull();
  });
});
