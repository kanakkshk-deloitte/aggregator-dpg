import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getSessionMock = vi.fn();
vi.mock('@/lib/server-session', () => ({ getSession: getSessionMock }));

const cookiesGetMock = vi.fn();
vi.mock('next/headers', () => ({ cookies: () => ({ get: cookiesGetMock }) }));

const refreshMock = vi.fn();
vi.mock('@/lib/oidc', () => ({ getOidcAdapter: () => ({ refresh: refreshMock }) }));

const destroyMock = vi.fn();
const updateMock = vi.fn();
vi.mock('@/lib/session', () => ({
  getSessionStore: () => ({ destroy: destroyMock, update: updateMock }),
}));

const { getFreshAccessToken, callApi } = await import('@/lib/upstream-client');

const FAR_FUTURE = Date.now() + 10 * 60_000;
const NEAR_EXPIRY = Date.now() + 30_000; // within the 60s refresh window

describe('getFreshAccessToken', () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    cookiesGetMock.mockReset();
    refreshMock.mockReset();
    destroyMock.mockReset();
    updateMock.mockReset();
  });

  it('returns null when there is no active session', async () => {
    getSessionMock.mockResolvedValue(null);
    await expect(getFreshAccessToken()).resolves.toBeNull();
  });

  it('returns the current access token when it is not near expiry', async () => {
    getSessionMock.mockResolvedValue({ accessToken: 'AT-1', accessTokenExp: FAR_FUTURE });
    await expect(getFreshAccessToken()).resolves.toBe('AT-1');
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('refreshes and persists the new tokens when near expiry', async () => {
    getSessionMock.mockResolvedValue({
      accessToken: 'AT-OLD',
      accessTokenExp: NEAR_EXPIRY,
      refreshToken: 'RT-OLD',
    });
    cookiesGetMock.mockReturnValue({ value: 'sid-1' });
    refreshMock.mockResolvedValue({
      ok: true,
      value: {
        accessToken: 'AT-NEW',
        refreshToken: 'RT-NEW',
        idToken: 'ID-NEW',
        accessTokenExp: FAR_FUTURE,
        refreshTokenExp: FAR_FUTURE,
      },
    });
    await expect(getFreshAccessToken()).resolves.toBe('AT-NEW');
    expect(updateMock).toHaveBeenCalledWith(
      'sid-1',
      expect.objectContaining({ accessToken: 'AT-NEW', refreshToken: 'RT-NEW' }),
    );
  });

  it('destroys the session and returns null when refresh fails', async () => {
    getSessionMock.mockResolvedValue({
      accessToken: 'AT-OLD',
      accessTokenExp: NEAR_EXPIRY,
      refreshToken: 'RT-OLD',
    });
    cookiesGetMock.mockReturnValue({ value: 'sid-2' });
    refreshMock.mockResolvedValue({ ok: false, error: { code: 'REFRESH_FAILED' } });
    await expect(getFreshAccessToken()).resolves.toBeNull();
    expect(destroyMock).toHaveBeenCalledWith('sid-2');
  });

  it('returns null on refresh failure when no sid cookie is present', async () => {
    getSessionMock.mockResolvedValue({
      accessToken: 'AT-OLD',
      accessTokenExp: NEAR_EXPIRY,
      refreshToken: 'RT-OLD',
    });
    cookiesGetMock.mockReturnValue(undefined);
    refreshMock.mockResolvedValue({ ok: false, error: { code: 'REFRESH_FAILED' } });
    await expect(getFreshAccessToken()).resolves.toBeNull();
    expect(destroyMock).not.toHaveBeenCalled();
  });

  it('returns null after a successful refresh if the sid cookie vanished mid-flight', async () => {
    getSessionMock.mockResolvedValue({
      accessToken: 'AT-OLD',
      accessTokenExp: NEAR_EXPIRY,
      refreshToken: 'RT-OLD',
    });
    cookiesGetMock.mockReturnValue(undefined);
    refreshMock.mockResolvedValue({
      ok: true,
      value: {
        accessToken: 'AT-NEW',
        refreshToken: 'RT-NEW',
        idToken: 'ID-NEW',
        accessTokenExp: FAR_FUTURE,
        refreshTokenExp: FAR_FUTURE,
      },
    });
    await expect(getFreshAccessToken()).resolves.toBeNull();
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe('callApi', () => {
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    getSessionMock.mockReset();
    cookiesGetMock.mockReset();
    process.env.API_BASE_URL = 'http://api.internal:4000';
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env.API_BASE_URL;
  });

  it('attaches the Bearer token and calls the upstream API', async () => {
    getSessionMock.mockResolvedValue({ accessToken: 'AT-1', accessTokenExp: FAR_FUTURE });
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await callApi('/v1/links');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.internal:4000/v1/links',
      expect.objectContaining({ method: 'GET' }),
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer AT-1');
  });

  it('sets a JSON content-type when a body is provided and none was set', async () => {
    getSessionMock.mockResolvedValue({ accessToken: 'AT-1', accessTokenExp: FAR_FUTURE });
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await callApi('/v1/links', { method: 'POST', body: { a: 1 } });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Headers;
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
  });

  it('throws when there is no active session', async () => {
    getSessionMock.mockResolvedValue(null);
    // CI on Node 24 / JSDOM 25 sometimes empties template-string error
    // messages; assert that the call throws rather than match the text.
    await expect(callApi('/v1/links')).rejects.toThrow();
  });

  it('falls back to localhost:4000 when API_BASE_URL is unset', async () => {
    delete process.env.API_BASE_URL;
    getSessionMock.mockResolvedValue({ accessToken: 'AT-1', accessTokenExp: FAR_FUTURE });
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await callApi('/v1/links');
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4000/v1/links', expect.anything());
  });
});
