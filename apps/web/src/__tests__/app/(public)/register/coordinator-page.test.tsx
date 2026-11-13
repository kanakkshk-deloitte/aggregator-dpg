/**
 * Server-component test: `(public)/register/coordinator/page.tsx` (#701).
 *
 * Covers the coordinator invite-landing gating: session → dashboard; no
 * invite token → /login (invite-only); happy path passes the invite token
 * + coordinator schema to CoordinatorInviteView.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
const { redirect, notFound } = vi.hoisted(() => ({
  redirect: vi.fn(() => {
    throw new Error('REDIRECT');
  }),
  notFound: vi.fn(() => {
    throw new Error('NOT_FOUND');
  }),
}));
const { loadConsentContent } = vi.hoisted(() => ({
  loadConsentContent: vi.fn(),
}));
const { loadRegistrationSchema } = vi.hoisted(() => ({ loadRegistrationSchema: vi.fn() }));

vi.mock('@/lib/server-session', () => ({ getSession }));
vi.mock('next/navigation', () => ({ redirect, notFound }));
vi.mock('@/app/(public)/register/register-server', () => ({
  loadConsentContent,
}));
vi.mock('@/lib/aggregator-schema.server', () => ({ loadRegistrationSchema }));

import CoordinatorInvitePage from '@/app/(public)/register/coordinator/page';

const schema = { title: 'Aggregator Registration', properties: {} };

beforeEach(() => {
  getSession.mockReset().mockResolvedValue(null);
  redirect.mockClear();
  notFound.mockClear();
  loadRegistrationSchema.mockReset().mockResolvedValue({ schema, uiSchema: {} });
  loadConsentContent.mockReset().mockResolvedValue({
    aggregator: { terms: { version: 1, title: 'T', content: 'T' }, privacy: {} },
    org: { terms: {}, privacy: {} },
  });
});

function run(invite?: string) {
  return CoordinatorInvitePage({
    searchParams: Promise.resolve(invite === undefined ? {} : { invite }),
  });
}
async function runAndCatch(invite?: string): Promise<string | null> {
  try {
    await run(invite);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

describe('CoordinatorInvitePage (server component)', () => {
  it('redirects to /dashboard when a session exists', async () => {
    getSession.mockResolvedValue({ sub: 'u1' });
    expect(await runAndCatch('inv')).toBe('REDIRECT');
    expect(redirect).toHaveBeenCalledWith('/dashboard');
  });

  it('redirects to /login when no invite token is present', async () => {
    expect(await runAndCatch(undefined)).toBe('REDIRECT');
    expect(redirect).toHaveBeenCalledWith('/login');
  });

  it('passes the invite token + schema to CoordinatorInviteView on the happy path', async () => {
    const el = await run('inv-jwt');
    expect(el.props.inviteToken).toBe('inv-jwt');
    expect(el.props.schema).toBe(schema);
    expect(el.props.aggregatorConsentContent).toEqual({
      terms: { version: 1, title: 'T', content: 'T' },
      privacy: {},
    });
    expect(redirect).not.toHaveBeenCalled();
  });
});
