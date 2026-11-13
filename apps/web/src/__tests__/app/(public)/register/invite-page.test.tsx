/**
 * Server-component test: `(public)/register/invite/page.tsx` (#701).
 *
 * Covers the owner invite-management deep-link gating: session → dashboard;
 * missing grant → notFound; happy path passes the grant
 * to OwnerInviteView. The grant is NOT verified here (the mint POST is the gate).
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
vi.mock('@/lib/server-session', () => ({ getSession }));
vi.mock('next/navigation', () => ({ redirect, notFound }));

import OwnerInvitePage from '@/app/(public)/register/invite/page';

beforeEach(() => {
  getSession.mockReset().mockResolvedValue(null);
  redirect.mockClear();
  notFound.mockClear();
});

function run(grant?: string) {
  return OwnerInvitePage({ searchParams: Promise.resolve(grant === undefined ? {} : { grant }) });
}
async function runAndCatch(grant?: string): Promise<string | null> {
  try {
    await run(grant);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

describe('OwnerInvitePage (server component)', () => {
  it('redirects to /dashboard when a session exists', async () => {
    getSession.mockResolvedValue({ sub: 'u1' });
    expect(await runAndCatch('g')).toBe('REDIRECT');
    expect(redirect).toHaveBeenCalledWith('/dashboard');
  });

  it('404s when no grant is present', async () => {
    expect(await runAndCatch(undefined)).toBe('NOT_FOUND');
    expect(notFound).toHaveBeenCalled();
  });

  it('passes the grant to OwnerInviteView on the happy path', async () => {
    const el = await run('grant-jwt');
    expect(el.props.grant).toBe('grant-jwt');
    expect(redirect).not.toHaveBeenCalled();
    expect(notFound).not.toHaveBeenCalled();
  });
});
