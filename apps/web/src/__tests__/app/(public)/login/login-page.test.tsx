/**
 * Server-component test: `(public)/login/page.tsx`.
 *
 * Invokes the async page function directly (no React render needed — it's a
 * plain server component) and asserts the session-redirect guard, the
 * cookie-vs-query-string precedence for `returnTo`/`error`, and the
 * open-redirect guard on an unsafe `returnTo`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
const { redirect } = vi.hoisted(() => ({ redirect: vi.fn() }));
const { cookies } = vi.hoisted(() => ({ cookies: vi.fn() }));

vi.mock('@/lib/server-session', () => ({ getSession }));
vi.mock('next/navigation', () => ({ redirect }));
vi.mock('next/headers', () => ({ cookies }));

import LoginPage from '@/app/(public)/login/page';

function makeCookieJar(values: Record<string, string> = {}) {
  return {
    get: (name: string) => (values[name] !== undefined ? { value: values[name] } : undefined),
  };
}

describe('LoginPage (server component)', () => {
  beforeEach(() => {
    getSession.mockReset();
    redirect.mockReset();
    cookies.mockReset();
  });

  it('redirects to /dashboard when a session already exists', async () => {
    getSession.mockResolvedValue({ sub: 'user-1' });
    cookies.mockResolvedValue(makeCookieJar());

    await LoginPage({ searchParams: Promise.resolve({}) });

    expect(redirect).toHaveBeenCalledWith('/dashboard');
  });

  it('renders LoginView with defaults when no cookies/params are set', async () => {
    getSession.mockResolvedValue(null);
    cookies.mockResolvedValue(makeCookieJar());

    const el = await LoginPage({ searchParams: Promise.resolve({}) });

    expect(el.props.returnTo).toBe('/dashboard');
    expect(el.props.error).toBeNull();
  });

  it('uses the query-string returnTo when it is a safe relative path', async () => {
    getSession.mockResolvedValue(null);
    cookies.mockResolvedValue(makeCookieJar());

    const el = await LoginPage({
      searchParams: Promise.resolve({ returnTo: '/dashboard/onboarding' }),
    });

    expect(el.props.returnTo).toBe('/dashboard/onboarding');
  });

  it('falls back to /dashboard for an unsafe (protocol-relative) returnTo', async () => {
    getSession.mockResolvedValue(null);
    cookies.mockResolvedValue(makeCookieJar());

    const el = await LoginPage({
      searchParams: Promise.resolve({ returnTo: '//evil.example.com' }),
    });

    expect(el.props.returnTo).toBe('/dashboard');
  });

  it('falls back to /dashboard for an absolute-URL returnTo', async () => {
    getSession.mockResolvedValue(null);
    cookies.mockResolvedValue(makeCookieJar());

    const el = await LoginPage({
      searchParams: Promise.resolve({ returnTo: 'https://evil.example.com' }),
    });

    expect(el.props.returnTo).toBe('/dashboard');
  });

  it('prefers the logout-return cookie over the query string', async () => {
    getSession.mockResolvedValue(null);
    cookies.mockResolvedValue(makeCookieJar({ bd_logout_return: '/dashboard/profile' }));

    const el = await LoginPage({
      searchParams: Promise.resolve({ returnTo: '/dashboard/other' }),
    });

    expect(el.props.returnTo).toBe('/dashboard/profile');
  });

  it('maps the "expired" logout-reason cookie to session_expired', async () => {
    getSession.mockResolvedValue(null);
    cookies.mockResolvedValue(makeCookieJar({ bd_logout_reason: 'expired' }));

    const el = await LoginPage({ searchParams: Promise.resolve({}) });

    expect(el.props.error).toBe('session_expired');
  });

  it('maps the "console_no_org" logout-reason cookie through unchanged', async () => {
    getSession.mockResolvedValue(null);
    cookies.mockResolvedValue(makeCookieJar({ bd_logout_reason: 'console_no_org' }));

    const el = await LoginPage({ searchParams: Promise.resolve({}) });

    expect(el.props.error).toBe('console_no_org');
  });

  it('falls back to the raw query-string error when no reason cookie is set', async () => {
    getSession.mockResolvedValue(null);
    cookies.mockResolvedValue(makeCookieJar());

    const el = await LoginPage({
      searchParams: Promise.resolve({ error: 'oidc_error_access_denied' }),
    });

    expect(el.props.error).toBe('oidc_error_access_denied');
  });
});
