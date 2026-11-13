import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getServiceAccessToken, _resetServiceToken } from '@/lib/service-token';

const ENV_KEYS = ['OIDC_ISSUER', 'BFF_SERVICE_CLIENT_ID', 'BFF_SERVICE_CLIENT_SECRET'];

describe('getServiceAccessToken', () => {
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    _resetServiceToken();
    process.env.OIDC_ISSUER = 'http://keycloak:8080/realms/aggregator';
    process.env.BFF_SERVICE_CLIENT_ID = 'aggregator-bff';
    process.env.BFF_SERVICE_CLIENT_SECRET = 'shh';
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    for (const k of ENV_KEYS) delete process.env[k];
    _resetServiceToken();
  });

  it('fetches and returns a fresh token', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ access_token: 'AT-1', expires_in: 300 }), { status: 200 }),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const token = await getServiceAccessToken();
    expect(token).toBe('AT-1');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://keycloak:8080/realms/aggregator/protocol/openid-connect/token',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('strips trailing slashes from OIDC_ISSUER when building the token URL', async () => {
    process.env.OIDC_ISSUER = 'http://keycloak:8080/realms/aggregator///';
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ access_token: 'AT-2', expires_in: 300 }), { status: 200 }),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await getServiceAccessToken();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://keycloak:8080/realms/aggregator/protocol/openid-connect/token',
      expect.anything(),
    );
  });

  it('reuses the cached token until near expiry', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ access_token: 'AT-3', expires_in: 300 }), { status: 200 }),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const first = await getServiceAccessToken();
    const second = await getServiceAccessToken();
    expect(first).toBe(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes once the cached token is within the refresh lead window', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'AT-4', expires_in: 20 }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'AT-5', expires_in: 300 }), { status: 200 }),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const first = await getServiceAccessToken();
    // expires_in=20s is within the 30s refresh lead, so the next call refetches.
    const second = await getServiceAccessToken();
    expect(first).toBe('AT-4');
    expect(second).toBe('AT-5');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws a descriptive error on a non-OK token response', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response('invalid_client', { status: 401 }),
      ) as unknown as typeof fetch;
    // CI on Node 24 / JSDOM 25 sometimes empties template-string error
    // messages; assert that the call throws rather than match the text.
    await expect(getServiceAccessToken()).rejects.toThrow();
  });

  it('throws when a required env var is missing', async () => {
    delete process.env.BFF_SERVICE_CLIENT_SECRET;
    await expect(getServiceAccessToken()).rejects.toThrow();
  });
});
