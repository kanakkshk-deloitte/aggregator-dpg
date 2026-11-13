/**
 * Server Component test: `(console)/console/layout.tsx` — actor routing
 * (user & org Phase 5).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionData } from '@/lib/session';
import type { MeResponse } from '@aggregator-dpg/shared-primitives/user-org';

vi.mock('@/lib/server-session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/console-actor', () => ({ getConsoleActor: vi.fn() }));
const sidebarProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));
vi.mock('@/components/console/ConsoleSidebar', () => ({
  ConsoleSidebar: (props: Record<string, unknown>) => {
    sidebarProps.last = props;
    return <nav data-testid="console-nav" />;
  },
}));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
vi.mock('next/headers', () => ({
  headers: vi.fn(async () => ({
    get: (key: string) => (key === 'x-pathname' ? '/console' : null),
  })),
}));

import ConsoleLayout from '@/app/(console)/console/layout';
import { getSession } from '@/lib/server-session';
import { getConsoleActor } from '@/lib/console-actor';
import { redirect } from 'next/navigation';

const session = {
  sub: 's',
  accessToken: 't',
  refreshToken: 'r',
  idToken: 'i',
  accessTokenExp: Date.now() + 1e6,
  refreshTokenExp: Date.now() + 1e6,
  createdAt: 0,
  lastSeenAt: 0,
} as SessionData;

const me = (over: Partial<MeResponse>): MeResponse => ({
  kind: 'admin',
  user: { id: 'u', contact: { name: null, email: 'a@a.org', phone: null } },
  orgs: [],
  is_network_admin: false,
  ...over,
});

describe('<ConsoleLayout />', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the console for an admin', async () => {
    vi.mocked(getSession).mockResolvedValue(session);
    vi.mocked(getConsoleActor).mockResolvedValue({ ok: true, me: me({}) });
    const el = await ConsoleLayout({ children: <p>child</p> });
    expect(el).toBeTruthy();
    expect(redirect).not.toHaveBeenCalled();
  });

  it('gives the network admin no Users link in the sidebar', async () => {
    vi.mocked(getSession).mockResolvedValue(session);
    vi.mocked(getConsoleActor).mockResolvedValue({
      ok: true,
      me: me({
        is_network_admin: true,
        capabilities: ['network.administer', 'org.manage'],
        orgs: [
          {
            id: 'root',
            name: 'Network',
            slug: 'network',
            org_type: 'network_facilitator',
            role: 'owner',
            is_default: false,
            capabilities: ['network.administer'],
          },
        ],
      }),
    });
    const { render } = await import('@testing-library/react');
    render(await ConsoleLayout({ children: <p>child</p> }));
    expect(sidebarProps.last).toMatchObject({ canManage: false, homeIsCoordinators: false });
  });

  it('keeps the email row and drops an empty phone in the account card', async () => {
    vi.mocked(getSession).mockResolvedValue(session);
    const { render } = await import('@testing-library/react');
    vi.mocked(getConsoleActor).mockResolvedValue({ ok: true, me: me({}) });
    render(await ConsoleLayout({ children: <p>child</p> }));
    const bare = sidebarProps.last?.['account'] as {
      title: string;
      details: Array<{ value: string }>;
    };
    expect(bare.title).toBe('a@a.org');
    expect(bare.details.map((d) => d.value)).toEqual(['a@a.org']);

    vi.mocked(getConsoleActor).mockResolvedValue({
      ok: true,
      me: me({
        user: { id: 'u', contact: { name: 'Asha', email: 'a@a.org', phone: '+919000000001' } },
      }),
    });
    render(await ConsoleLayout({ children: <p>child</p> }));
    const account = sidebarProps.last?.['account'] as {
      title: string;
      details: Array<{ value: string }>;
    };
    expect(account.title).toBe('Asha');
    expect(account.details.map((d) => d.value)).toEqual(['a@a.org', '+919000000001']);
  });

  it('sends a coordinator to the portal', async () => {
    vi.mocked(getSession).mockResolvedValue(session);
    vi.mocked(getConsoleActor).mockResolvedValue({ ok: true, me: me({ kind: 'coordinator' }) });
    await expect(ConsoleLayout({ children: null })).rejects.toThrow();
    expect(redirect).toHaveBeenCalledWith('/dashboard');
  });

  it.each([
    ['not_provisioned', 'console_not_provisioned'],
    ['no_org', 'console_no_org'],
  ] as const)('signs out an admin the API refuses (%s)', async (reason, code) => {
    vi.mocked(getSession).mockResolvedValue(session);
    vi.mocked(getConsoleActor).mockResolvedValue({ ok: false, reason });
    await expect(ConsoleLayout({ children: null })).rejects.toThrow();
    expect(redirect).toHaveBeenCalledWith(`/api/auth/logout?reason=${code}`);
  });

  it('sends a visitor without a session to login', async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    await expect(ConsoleLayout({ children: null })).rejects.toThrow();
    expect(redirect).toHaveBeenCalledWith('/api/auth/login?returnTo=%2Fconsole');
  });
});
