/**
 * BFF route test: GET /api/auth/logout.
 *
 * Mocks `@/lib/oidc` (buildLogoutUrl) and `@/lib/session` (getSessionStore)
 * since the real adapter/store hit Keycloak/Redis. Asserts session
 * destruction, the `sid` cookie clear, the reason/return hint cookies, and
 * the bare (query-free) redirect target required by Keycloak's strict
 * redirect-uri match.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/oidc', () => ({
  getOidcAdapter: vi.fn(),
}));
vi.mock('@/lib/session', () => ({
  getSessionStore: vi.fn(),
}));

import { GET } from '@/app/api/auth/logout/route';
import { getOidcAdapter } from '@/lib/oidc';
import { getSessionStore } from '@/lib/session';

const mockGetOidcAdapter = vi.mocked(getOidcAdapter);
const mockGetSessionStore = vi.mocked(getSessionStore);

describe('GET /api/auth/logout', () => {
  let originalPublicUrl: string | undefined;
  const destroy = vi.fn(async () => undefined);
  const get = vi.fn();
  const buildLogoutUrl = vi.fn(async () => 'https://kc.test/logout?id_token_hint=abc');

  beforeEach(() => {
    originalPublicUrl = process.env.PUBLIC_PORTAL_URL;
    process.env.PUBLIC_PORTAL_URL = 'http://portal.test';
    mockGetSessionStore.mockReturnValue({
      create: vi.fn(),
      get,
      update: vi.fn(),
      destroy,
      close: vi.fn(),
    } as never);
    mockGetOidcAdapter.mockReturnValue({
      buildAuthorizationUrl: vi.fn(),
      exchangeCode: vi.fn(),
      refresh: vi.fn(),
      buildLogoutUrl,
    } as never);
  });

  afterEach(() => {
    if (originalPublicUrl === undefined) delete process.env.PUBLIC_PORTAL_URL;
    else process.env.PUBLIC_PORTAL_URL = originalPublicUrl;
    vi.clearAllMocks();
  });

  it('destroys the session and redirects to the IdP end-session URL when a session exists', async () => {
    get.mockResolvedValue({ ok: true, value: { idToken: 'id-token-abc' } });
    const req = new NextRequest('http://localhost/api/auth/logout', {
      headers: { cookie: 'sid=sess-1' },
    });
    const res = await GET(req);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://kc.test/logout?id_token_hint=abc');
    expect(destroy).toHaveBeenCalledWith('sess-1');
    expect(buildLogoutUrl).toHaveBeenCalledWith({
      idToken: 'id-token-abc',
      postLogoutRedirectUri: 'http://portal.test/login',
    });
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('sid=;');
  });

  it('redirects bare to /login when there is no sid cookie', async () => {
    const req = new NextRequest('http://localhost/api/auth/logout');
    const res = await GET(req);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://portal.test/login');
    expect(destroy).not.toHaveBeenCalled();
    expect(buildLogoutUrl).not.toHaveBeenCalled();
  });

  it('redirects bare to /login when the session lookup misses', async () => {
    get.mockResolvedValue({ ok: false, error: { code: 'NOT_FOUND', message: 'gone' } });
    const req = new NextRequest('http://localhost/api/auth/logout', {
      headers: { cookie: 'sid=sess-2' },
    });
    const res = await GET(req);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://portal.test/login');
    expect(destroy).toHaveBeenCalledWith('sess-2');
  });

  it('sets short-lived reason/return hint cookies when provided', async () => {
    const req = new NextRequest(
      'http://localhost/api/auth/logout?reason=session_expired&return=%2Fdashboard',
    );
    const res = await GET(req);
    const setCookie = res.headers.getSetCookie
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie') ?? ''];
    const joined = setCookie.join(' | ');
    expect(joined).toContain('bd_logout_reason=session_expired');
    expect(joined).toContain('bd_logout_return=%2Fdashboard');
  });
});
