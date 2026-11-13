/**
 * BFF route test: GET /api/auth/callback.
 *
 * Mocks `@/lib/oidc` (exchangeCode) and `@/lib/session` (getSessionStore)
 * since the real adapter/store hit Keycloak/Redis. Uses the *real*
 * `signFlowState`/`verifyFlowState` from `@/lib/cookies` (pure HMAC, no I/O)
 * so the flow-cookie round trip is exercised for real. Crafts a fake JWT
 * (base64url payload, no real signature — `tokenAggregatorId` never
 * verifies the signature) to drive the coordinator-gate branch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { signFlowState } from '@/lib/cookies';

const { resolveSignalsRealmRolesMock } = vi.hoisted(() => ({
  resolveSignalsRealmRolesMock: vi.fn(async (): Promise<string[]> => []),
}));
vi.mock('@/lib/signals-roles', () => ({
  resolveSignalsRealmRoles: resolveSignalsRealmRolesMock,
}));
vi.mock('@/lib/oidc', () => ({
  getOidcAdapter: vi.fn(),
}));
vi.mock('@/lib/session', () => ({
  getSessionStore: vi.fn(),
}));

import { GET } from '@/app/api/auth/callback/route';
import { getOidcAdapter } from '@/lib/oidc';
import { getSessionStore } from '@/lib/session';

const mockGetOidcAdapter = vi.mocked(getOidcAdapter);
const mockGetSessionStore = vi.mocked(getSessionStore);

function fakeJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.sig`;
}

function flowCookie(returnTo = '/dashboard'): string {
  return signFlowState({
    state: 'state-1',
    nonce: 'nonce-1',
    codeVerifier: 'verifier-1',
    returnTo,
  });
}

describe('GET /api/auth/callback', () => {
  let originalSessionKey: string | undefined;
  let originalRedirectUri: string | undefined;
  let originalPublicUrl: string | undefined;
  const exchangeCode = vi.fn();
  const create = vi.fn(async () => 'new-sid');

  beforeEach(() => {
    originalSessionKey = process.env.SESSION_KEY;
    originalRedirectUri = process.env.OIDC_REDIRECT_URI;
    originalPublicUrl = process.env.PUBLIC_PORTAL_URL;
    process.env.SESSION_KEY = 'x'.repeat(32);
    process.env.OIDC_REDIRECT_URI = 'http://localhost:3000/api/auth/callback';
    process.env.PUBLIC_PORTAL_URL = 'http://portal.test';
    mockGetOidcAdapter.mockReturnValue({
      buildAuthorizationUrl: vi.fn(),
      exchangeCode,
      refresh: vi.fn(),
      buildLogoutUrl: vi.fn(),
    } as never);
    mockGetSessionStore.mockReturnValue({
      create,
      get: vi.fn(),
      update: vi.fn(),
      destroy: vi.fn(),
      close: vi.fn(),
    } as never);
  });

  afterEach(() => {
    if (originalSessionKey === undefined) delete process.env.SESSION_KEY;
    else process.env.SESSION_KEY = originalSessionKey;
    if (originalRedirectUri === undefined) delete process.env.OIDC_REDIRECT_URI;
    else process.env.OIDC_REDIRECT_URI = originalRedirectUri;
    if (originalPublicUrl === undefined) delete process.env.PUBLIC_PORTAL_URL;
    else process.env.PUBLIC_PORTAL_URL = originalPublicUrl;
    vi.clearAllMocks();
  });

  it('exchanges the code, creates a session, and redirects to returnTo', async () => {
    exchangeCode.mockResolvedValue({
      ok: true,
      value: {
        tokens: {
          accessToken: fakeJwt({ aggregator_id: 'agg-1' }),
          refreshToken: 'refresh-1',
          idToken: 'id-1',
          accessTokenExp: Date.now() + 60_000,
          refreshTokenExp: Date.now() + 60_000,
        },
        claims: { sub: 'user-1', email: 'jane@x.com' },
      },
    });
    const req = new NextRequest('http://localhost/api/auth/callback?code=abc&state=state-1', {
      headers: { cookie: `oidc_flow=${flowCookie('/dashboard')}` },
    });
    const res = await GET(req);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://portal.test/dashboard');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'user-1', email: 'jane@x.com' }),
    );
    const setCookie = res.headers.getSetCookie
      ? res.headers.getSetCookie().join(' | ')
      : (res.headers.get('set-cookie') ?? '');
    expect(setCookie).toContain('sid=new-sid');
    expect(setCookie).toContain('oidc_flow=;');
  });

  it('redirects to /login with the oidc_error reason when the IdP reports an error', async () => {
    const req = new NextRequest(
      'http://localhost/api/auth/callback?error=access_denied&error_description=nope',
    );
    const res = await GET(req);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'http://portal.test/login?error=oidc_error_access_denied',
    );
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it('redirects to /login when code or state is missing', async () => {
    const req = new NextRequest('http://localhost/api/auth/callback?code=abc');
    const res = await GET(req);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'http://portal.test/login?error=missing_code_or_state',
    );
  });

  it('redirects to /login when the flow cookie is missing or invalid', async () => {
    const req = new NextRequest('http://localhost/api/auth/callback?code=abc&state=state-1');
    const res = await GET(req);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://portal.test/login?error=invalid_flow_cookie');
  });

  it('redirects to /login when token exchange fails', async () => {
    exchangeCode.mockResolvedValue({
      ok: false,
      error: { code: 'TOKEN_EXCHANGE_FAILED', message: 'bad code' },
    });
    const req = new NextRequest('http://localhost/api/auth/callback?code=abc&state=state-1', {
      headers: { cookie: `oidc_flow=${flowCookie()}` },
    });
    const res = await GET(req);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'http://portal.test/login?error=exchange_token_exchange_failed',
    );
    expect(create).not.toHaveBeenCalled();
  });

  /**
   * One Keycloak realm serves this portal and the Signals app, so "no
   * aggregator_id" covers three different populations. The reason code has to
   * tell them apart or the login screen shows org-owner advice to a Signals
   * participant (#753).
   */
  function blockedWith(roles: string[], returnTo = '/dashboard'): Promise<Response> {
    exchangeCode.mockResolvedValue({
      ok: true,
      value: {
        tokens: {
          accessToken: fakeJwt({ sub: 'no-agg-1', realm_access: { roles } }),
          refreshToken: 'refresh-1',
          idToken: 'id-1',
          accessTokenExp: Date.now() + 60_000,
          refreshTokenExp: Date.now() + 60_000,
        },
        claims: { sub: 'no-agg-1' },
      },
    });
    const req = new NextRequest('http://localhost/api/auth/callback?code=abc&state=state-1', {
      headers: { cookie: `oidc_flow=${flowCookie(returnTo)}` },
    });
    return GET(req);
  }

  it('signs an org owner in and lands them on the console (Phase 5)', async () => {
    const res = await blockedWith(['org_owner']);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://portal.test/console');
    expect(create).toHaveBeenCalled();
  });

  it('keeps an org owner on a requested console page', async () => {
    const res = await blockedWith(['org_owner'], '/console/orgs');
    expect(res.headers.get('location')).toBe('http://portal.test/console/orgs');
  });

  it('blocks a Signals participant with signals_account_no_portal', async () => {
    resolveSignalsRealmRolesMock.mockResolvedValueOnce(['seeker', 'provider']);
    const res = await blockedWith(['seeker']);
    expect(res.headers.get('location')).toBe(
      'http://portal.test/login?error=signals_account_no_portal',
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('blocks any other realm user with no_portal_access', async () => {
    const res = await blockedWith(['offline_access']);
    expect(res.headers.get('location')).toBe('http://portal.test/login?error=no_portal_access');
    expect(create).not.toHaveBeenCalled();
  });

  it('falls back to no_portal_access when no Signals roles are configured', async () => {
    // A wrong message is worse than a generic one: with neither
    // `aggregator.signals.realm_roles` nor the SIGNALS_REALM_ROLES override we
    // cannot claim the user is a Signals account. The resolver returns [] for
    // both the unconfigured and the unreadable-config case.
    resolveSignalsRealmRolesMock.mockResolvedValueOnce([]);
    const res = await blockedWith(['seeker']);
    expect(res.headers.get('location')).toBe('http://portal.test/login?error=no_portal_access');
  });
});
