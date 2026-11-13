/**
 * Server-component test: `(public)/register/owner/page.tsx` (#619).
 *
 * Invokes the async page function directly. Covers the deep-link gating chain:
 * session → redirect; org schema missing →
 * notFound; and the happy path rendering OwnerRegisterView with the org schema
 * + org consent content.
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
const { loadOrgSchema, loadConsentContent } = vi.hoisted(() => ({
  loadOrgSchema: vi.fn(),
  loadConsentContent: vi.fn(),
}));

vi.mock('@/lib/server-session', () => ({ getSession }));
vi.mock('next/navigation', () => ({ redirect, notFound }));
vi.mock('@/app/(public)/register/register-server', () => ({
  loadOrgSchema,
  loadConsentContent,
}));

import OwnerRegisterPage from '@/app/(public)/register/owner/page';

const orgSchema = { title: 'Organisation Registration', properties: {} };

beforeEach(() => {
  getSession.mockReset().mockResolvedValue(null);
  redirect.mockClear();
  notFound.mockClear();
  loadOrgSchema.mockReset().mockResolvedValue({ schema: orgSchema, uiSchema: {} });
  loadConsentContent.mockReset().mockResolvedValue({
    aggregator: { terms: {}, privacy: {} },
    org: { terms: { version: 1, title: 'T', content: 'T' }, privacy: {} },
  });
});

/** Runs the page and returns the thrown error's message (or null if none). */
async function runAndCatch(): Promise<string | null> {
  try {
    await OwnerRegisterPage();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

describe('OwnerRegisterPage (server component)', () => {
  it('redirects to /dashboard when a session already exists', async () => {
    getSession.mockResolvedValue({ sub: 'u1' });
    expect(await runAndCatch()).toBe('REDIRECT');
    expect(redirect).toHaveBeenCalledWith('/dashboard');
  });

  it('404s when the org schema is missing', async () => {
    loadOrgSchema.mockResolvedValue(null);
    expect(await runAndCatch()).toBe('NOT_FOUND');
    expect(notFound).toHaveBeenCalled();
  });

  it('renders OwnerRegisterView with the org schema + org consent on the happy path', async () => {
    const el = await OwnerRegisterPage();
    expect(el.props.schema).toBe(orgSchema);
    expect(el.props.uiSchema).toEqual({});
    expect(el.props.orgConsentContent).toEqual({
      terms: { version: 1, title: 'T', content: 'T' },
      privacy: {},
    });
    expect(redirect).not.toHaveBeenCalled();
    expect(notFound).not.toHaveBeenCalled();
  });
});
